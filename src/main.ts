import "@logseq/libs";
import { BlockEntity, BlockUUID, IHookEvent, SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin.user";
import OpenAI from "openai";

import { deepFirstTraversal } from './utils'
import { logseq as PL } from "../package.json";

const pluginId = PL.id;
const loadingKey = 'loading'

const hasSpace = (str: string) => /\s/.test(str)

const getBlockTags = async (content: string): Promise<string[]> => {
  const { apiKey, apiBaseUrl, model } = logseq.settings!;

  const openai = new OpenAI({
    apiKey,
    baseURL: apiBaseUrl,
    dangerouslyAllowBrowser: true,
  });

  logseq.UI.showMsg('Generating tags with AI...', 'warning', { key: loadingKey, timeout: 100000000 });

  try {
    const systemPrompt = `You are a highly intelligent tagging assistant. Your goal is to generate a concise list of highly relevant tags for the provided text. Follow these rules strictly: 1. Generate a maximum of 5 tags. 2. The tags must be extremely relevant to the core concepts of the text. 3. The language of the tags MUST match the language of the provided text (e.g., if the text is in Chinese, the tags must be in Chinese). 4. Return the tags as a JSON object with a single key "tags" containing an array of strings. For example: {"tags": ["核心概念1", "关键主题2"]}.`;

    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: content },
      ],
      response_format: { type: "json_object" },
    });

    logseq.UI.closeMsg(loadingKey);

    const result = response.choices[0].message?.content;
    if (result) {
      // The result is a JSON string like `{"tags": ["tag1", "tag2"]}`
      // We need to parse it to get the array.
      const parsedResult = JSON.parse(result);
      // Assuming the AI returns a JSON object with a "tags" key.
      // This might need adjustment based on the actual model's output format.
      // A more robust implementation could check for different possible keys.
      const tags = parsedResult.tags || parsedResult.Keywords || parsedResult.keywords || parsedResult;
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
    default: 'gpt-3.5-turbo',
    title: 'Model Name',
    description: 'The name of the model to use for generating tags (e.g., gpt-3.5-turbo).',
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
