import "@logseq/libs";
import { BlockEntity, BlockUUID, IHookEvent, SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin.user";
import OpenAI from "openai";

import { deepFirstTraversal, getAllGraphTags } from './utils'
import { logseq as PL } from "../package.json";

const pluginId = PL.id;
const loadingKey = 'loading'

const hasSpace = (str: string) => /\s/.test(str)

/**
 * Normalize a string for cheap relevance matching: lowercase, strip non-alphanumeric
 * characters, and collapse PascalCase / camelCase into space-separated words so
 * that "ArtificialIntelligence" matches "artificial intelligence" in the content.
 *
 * The PascalCase split is a no-op for CJK text (no casing to split on), so this is
 * safe to run on mixed-script content.
 */
const normalizeForMatch = (str: string): string =>
  str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split PascalCase / camelCase
    .toLowerCase()
    .replace(/[^a-z0-9\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ') // keep Latin, CJK, kana, hangul
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Locale-aware word segmenter. `Intl.Segmenter` with `granularity: 'word'` handles
 * space-delimited scripts (Latin, Cyrillic, ...) AND scripts without word
 * boundaries (CJK, Thai, ...), so it works for Chinese/Japanese/Korean tags where
 * a naive `split(' ')` would return the whole string as one token.
 *
 * The segmenter always uses the runtime default locale (`undefined`). Segmentation
 * is script-aware rather than locale-dependent for our purposes, so the default
 * fallback works fine for all scripts. The `language` plugin setting is only used
 * to instruct the AI which language to generate tags in — it is not passed here.
 *
 * The segmenter is constructed lazily and cached so we don't rebuild it on every
 * `tokenize` call.
 */
let _segmenter: Intl.Segmenter | null = null;

const getWordSegmenter = (): Intl.Segmenter => {
  if (_segmenter === null) {
    _segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  }
  return _segmenter;
};

/**
 * Tokenize a normalized string into lowercase word tokens.
 *
 * - Uses `Intl.Segmenter` so CJK text is segmented into meaningful units instead
 *   of being treated as one giant token.
 * - Drops non-word-like segments (punctuation, whitespace).
 *
 * No stop-word list or minimum-length floor is applied: those heuristics are
 * language-specific (Latin-centric) and would silently drop valid tokens in
 * CJK and other scripts where single-character words are common.
 */
const tokenize = (str: string): string[] => {
  const tokens: string[] = [];
  for (const seg of getWordSegmenter().segment(str)) {
    if (!seg.isWordLike) continue;
    tokens.push(seg.segment.toLowerCase());
  }
  return tokens;
};

/**
 * Cheap pre-filter for the existing-tags shortlist.
 *
 * Keeps a tag if there is any token overlap between the tag and the content in
 * either direction:
 *  - the tag (or any of its words) appears as a substring of the content, or
 *  - any word of the content appears as a substring of the tag.
 *
 * This is intentionally fuzzy and fast (no embeddings, no API calls) — its only
 * job is to shrink the candidate set the model sees so it's more likely to reuse
 * existing tags instead of inventing divergent ones.
 *
 * If the filter is too aggressive and yields fewer than `minCandidates`, fall back
 * to the capped unfiltered shortlist so the model still has existing tags to reuse.
 */
const filterRelevantTags = (
  tags: string[],
  content: string,
  minCandidates = 5,
  maxCandidates = 200,
): string[] => {
  if (tags.length === 0) return [];

  const normalizedContent = normalizeForMatch(content);
  if (!normalizedContent) return tags.slice(0, maxCandidates);

  const contentWords = new Set(tokenize(normalizedContent));

  const matched = tags.filter(tag => {
    const normalizedTag = normalizeForMatch(tag);
    if (!normalizedTag) return false;

    // 1. Whole tag appears in the content (catches multi-word tags).
    if (normalizedContent.includes(normalizedTag)) return true;

    // 2. Any word of the tag appears in the content.
    const tagWords = tokenize(normalizedTag);
    if (tagWords.some(w => normalizedContent.includes(w))) return true;

    // 3. Any content word appears inside the tag (catches content terms that are
    //    a substring of a PascalCase tag, e.g. content "market" vs tag "LaborMarket").
    for (const word of contentWords) {
      if (normalizedTag.includes(word)) return true;
    }
    return false;
  });

  // Fall back to the unfiltered (but capped) shortlist if too few matched,
  // so the model still has existing tags to consider for reuse.
  if (matched.length < minCandidates) {
    return tags.slice(0, maxCandidates);
  }

  return matched.slice(0, maxCandidates);
}

const getBlockTags = async (content: string): Promise<string[]> => {
  const { apiKey, apiBaseUrl, model, sendExistingTags, maxExistingTags, language } = logseq.settings!;

  const openai = new OpenAI({
    apiKey,
    baseURL: apiBaseUrl,
    dangerouslyAllowBrowser: true,
  });

  logseq.UI.showMsg('Generating tags with AI...', 'warning', { key: loadingKey, timeout: 100000000 });

  try {
    // Retrieve the user's existing tags so the AI can prioritize reusing them over inventing new (divergent) tags.
    // Skipped entirely when the user disables the "Send Existing Tags" setting.
    // `maxExistingTags` caps how many are sent; clamp to [1, 200] to guard against bad settings.
    const maxTags = Math.min(Math.max(Number(maxExistingTags) || 5, 1), 200);
    const tagCandidates = sendExistingTags
      ? filterRelevantTags(await getAllGraphTags().then(tags => tags.slice(0, 200)), content, 5, maxTags)
      : [];
    const hasExistingTags = tagCandidates.length > 0;

    let systemPrompt = `You are a highly intelligent tagging assistant. Your goal is to generate a concise list of highly relevant tags for the provided text.\n`;

    if (hasExistingTags) {
      systemPrompt += `Here is a shortlist of the user's existing tags that might be relevant to this text: [${tagCandidates.join(", ")}]\n`;
      //NOTE: If a tag/page name ever contains ], backticks, or newlines, it could break the prompt structure. A sanitize step (strip/escape control chars, or wrap the list in a fenced block) would harden it.
    }

    systemPrompt += `Follow these rules strictly:\n`;

    if (hasExistingTags) {
      systemPrompt += `0. PRIORITIZE EXISTING TAGS: If an existing tag accurately describes a core concept, use it exactly as spelled above. Only create a new tag if none of the existing tags are a good fit.\n`;
    }

    systemPrompt += `1. QUANTITY & RELEVANCE: Generate a maximum of 5 tags. They must be extremely relevant to the core concepts of the text.
2. LEXICAL RULES FOR NEW TAGS: If you must create a brand new tag, you MUST format it using these rules:
   - Use singular nouns (e.g., prefer "Market" over "Markets").
   - Use PascalCase for multi-word tags with no spaces (e.g., "LaborMarket", "ArtificialIntelligence").`;

    if (hasExistingTags) {
      systemPrompt += `
   - Avoid creating synonyms for concepts that are already covered by the existing tags provided above.`;
    }

    systemPrompt += `
3. LANGUAGE: ${language ? `The language of any new tags MUST be ${language}.` : 'The language of any new tags MUST match the language of the provided text.'}
4. OUTPUT FORMAT: Return the tags as a JSON object with a single key "tags" containing an array of strings. For example: {"tags": ["CoreConcept", "OtherTopic"]}.`;

    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: content },
      ],
      response_format: { type: "json_object" }, 
      //NOTE: Some OpenAI-compatible providers/models don't support setting the response_format.
    });

    logseq.UI.closeMsg(loadingKey);

    const result = response.choices[0].message?.content;
    if (result) {
      // The result should be a JSON string like `{"tags": ["tag1", "tag2"]}`
      const parsedResult = JSON.parse(result);
      const tags = parsedResult.tags || parsedResult.Tags || parsedResult;
      if (Array.isArray(tags)) {
        return tags;
      }
    }
    throw new Error('Failed to parse tags from AI response.');
  } catch (err) {
    logseq.UI.closeMsg(loadingKey);
    logseq.UI.showMsg(`Error generating tags: ${(err as Error).message}`, 'error');
    throw err;
  }
}

const checkSettings = (): boolean => {
  if (!logseq.settings) {
    logseq.UI.showMsg('Settings are not available yet. Please try again later.', 'error');
    return false;
  }
  const requiredSettings = {
    apiKey: 'API Key',
    apiBaseUrl: 'API Base URL',
    model: 'Model Name'
  };

  for (const [key, title] of Object.entries(requiredSettings)) {
    if (!logseq.settings[key]) {
      logseq.UI.showMsg(`${title} is not set. Please configure it in the plugin settings.`, 'error');
      return false;
    }
  }
  return true;
}

const setBlockTags = async (e: IHookEvent & { uuid: BlockUUID }) => {
  if (!checkSettings()) {
    return;
  }
  const block = await logseq.Editor.getBlock(e.uuid)
  const contents: string[] = []

  if (!block) return
  await deepFirstTraversal([block], async (obj: BlockEntity) => {
    contents.push(obj.content)
  })

  if (contents.length) {
    const tags = await getBlockTags(contents.join('\n'))
    if (!Array.isArray(tags)) return
    await logseq.Editor.updateBlock(block?.uuid, `${block.content} ${tags.map((i: string) => `#${hasSpace(i) ? `[[${i}]]` : i}`).join(' ')}`)
    logseq.Editor.exitEditingMode()
  }
}

const setPageTags = async (e: IHookEvent & { page: string }) => {
  if (!checkSettings()) {
    return;
  }
  const page = await logseq.Editor.getPage(e.page)
  const tree = await logseq.Editor.getPageBlocksTree(e.page)
  if (!tree.length) return

  const { currentGraph } = await logseq.App.getUserConfigs()
  const basePath = currentGraph.split('logseq_local_')[1]
  const folder = page?.["journal?"] ? 'journals' : 'pages'
  const pageName = page?.["journal?"] ? page.journalDay?.toString().replace(/(\d{4})(\d{2})(\d{2})/, '$1_$2_$3') : page?.name

  const url = `file://${basePath}/${folder}/${pageName}.md`

  const content = await fetch(url).then(res => {
    return res.text()
  })

  const tags = await getBlockTags(content)
  if (!Array.isArray(tags)) return

  // Using regular expressions to match key:: value format
  const regex = /(\w+)::\s*([^]+?)(?:\n|$)/g;

  const matches = [];
  let match;
  while ((match = regex.exec(tree[0].content)) !== null) {
    const key = match[1];
    const value = match[2];
    matches.push({ key, value });
  }

  const properties = await logseq.Editor.getBlockProperties(tree[0].uuid)

  if (matches.length === 0 && page?.uuid) {
    await logseq.Editor.insertBlock(page.uuid, '', { before: true, properties: { tags } })
  } else if (matches.find(i => i.key === 'tags')) {
    await logseq.Editor.updateBlock(tree[0].uuid, '', { properties: { ...properties, tags: `${matches.find(i => i.key === 'tags')?.value}, ${tags.join(', ')}` } })
  } else {
    await logseq.Editor.updateBlock(tree[0].uuid, '', { properties: { ...properties, tags: tags.join(', ') } })
  }
  logseq.Editor.exitEditingMode()
}

const settingsSchema: SettingSchemaDesc[] = [
  {
    key: 'apiKey',
    type: 'string',
    default: '',
    title: 'API Key',
    description: 'Your API Key for the AI service (e.g., OpenAI).',
  },
  {
    key: 'apiBaseUrl',
    type: 'string',
    default: 'https://api.openai.com/v1',
    title: 'API Base URL',
    description: 'The base URL for the API. Useful for proxy or compatible services.',
  },
  {
    key: 'model',
    type: 'string',
    default: 'gpt-5-mini',
    title: 'Model Name',
    description: 'The name of the model to use for generating tags (e.g., gpt-5-mini).',
  },
  {
    key: 'sendExistingTags',
    type: 'boolean',
    default: false,
    title: 'Send Existing Tags',
    description: 'When enabled, the plugin retrieves your existing graph tags and sends them to the AI so it can prioritize reusing them. Disable to always generate fresh tags without the existing-tags context.',
  },
  {
    key: 'maxExistingTags',
    type: 'number',
    default: 5,
    title: 'Max Existing Tags to Send',
    description: 'Maximum number of existing tags to include in the prompt (after pre-filtering). Higher values give the AI more context but increase token usage and cost. Range: 1–200.',
  },
  {
    key: 'language',
    type: 'enum',
    default: '',
    title: 'Language / Locale',
    description: 'Force the AI to generate tags in this language. Select a language from the drop-down (shown as "EnglishName (NativeName)"). Leave empty to auto-detect from the text content.',
    enumChoices: [
      '',
      'Afrikaans',
      'Albanian (shqip)',
      'Arabic (العربية)',
      'Armenian (Հայերեն)',
      'Assamese (অসমীয়া)',
      'Azerbaijani (Azərbaycan)',
      'Bashkir (Башҡорт)',
      'Basque (euskara)',
      'Bengali (বাংলা)',
      'Bokmål (norsk bokmål)',
      'Bulgarian (български)',
      'Burmese (မြန်မာဘာသာ)',
      'Catalan (català)',
      'Chinese (中文)',
      'Croatian (hrvatski)',
      'Czech (čeština)',
      'Danish (dansk)',
      'Dutch (Nederlands)',
      'English',
      'Estonian (eesti)',
      'Faroese (føroyskt)',
      'Filipino',
      'Finnish (suomi)',
      'French (français)',
      'Galician (galego)',
      'Georgian (ქართული)',
      'German (Deutsch)',
      'Greek (Ελληνικά)',
      'Gujarati (ગુજરાતી)',
      'Hebrew (עברית)',
      'Hindi (हिंदी)',
      'Hungarian (magyar)',
      'Icelandic (íslenska)',
      'Indonesian (Bahasa Indonesia)',
      'Irish (Gaeilge)',
      'Italian (italiano)',
      'Japanese (日本語)',
      'Kannada (ಕನ್ನಡ)',
      'Kazakh (Қазақша)',
      'Khmer (ខ្មែរ)',
      'Kinyarwanda',
      'Kiswahili',
      'Korean (한국어)',
      'Kyrgyz (Кыргыз)',
      'Lao (ລາວ)',
      'Latvian (latviešu)',
      'Lithuanian (lietuvių)',
      'Malay (Bahasa Malaysia)',
      'Malayalam (മലയാളം)',
      'Maltese (Malti)',
      'Māori (Reo Māori)',
      'Marathi (मराठी)',
      'Mongolian (ᠮᠤᠨᠭᠭᠤᠯ ᠬᠡᠯᠡ)',
      'Nepali (नेपाली)',
      'Norwegian (norsk)',
      'Occitan',
      'Odia (ଓଡ଼ିଆ)',
      'Pashto (پښتو)',
      'Persian (فارسى)',
      'Polish (polski)',
      'Portuguese (português)',
      'Punjabi (ਪੰਜਾਬੀ)',
      'Romanian (română)',
      'Russian (русский)',
      'Sanskrit (संस्कृत)',
      'Serbian (srpski)',
      'Sesotho',
      'Sindhi (سِنڌِي)',
      'Sinhala (සිංහල)',
      'Slovak (slovenčina)',
      'Slovenian (slovenščina)',
      'Spanish (español)',
      'Swedish (svenska)',
      'Tagalog (Tagalog)',
      'Tajik (Тоҷикӣ)',
      'Tamil (தமிழ்)',
      'Tatar (Татарча)',
      'Telugu (తెలుగు)',
      'Thai (ไทย)',
      'Tibetan (བོད་ཡིག)',
      'Tswana (Setswana)',
      'Turkish (Türkçe)',
      'Turkmen (türkmençe)',
      'Ukrainian (українська)',
      'Urdu (اُردو)',
      'Uyghur (ئۇيغۇرچە)',
      'Uzbek (oʻzbek)',
      'Vietnamese (Tiếng Việt)',
      'Xhosa (isiXhosa)',
      'Yi (ꆈꌠꁱꂷ)',
      'Zulu (isiZulu)',
    ],
    enumPicker: 'select',
  },
];

async function main() {
  console.info(`#${pluginId}: MAIN`)

  logseq.useSettingsSchema(settingsSchema);

  logseq.Editor.registerSlashCommand('🤖 AI auto tags', setBlockTags)
  logseq.Editor.registerBlockContextMenuItem('🤖 AI auto tags', setBlockTags)
  logseq.App.registerPageMenuItem('🤖 AI auto tags', setPageTags)
}

logseq.ready(main).catch(console.error)
