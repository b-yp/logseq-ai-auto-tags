import { BlockEntity } from "@logseq/libs/dist/LSPlugin.user";

/**
 * Escape a string for safe use inside a RegExp.
 */
const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Query all existing tags in the current Logseq graph.
 *
 * Collects tags from two sources:
 *  1. Block references — `#tag` / `#[[tag]]` links inside block content.
 *  2. Page properties — `tags::` page-level property values.
 *
 * Page-property blocks are excluded from the block-ref query so they aren't
 * double-counted with the page-tags query.
 *
 * @returns Deduplicated array of tag names (lowercased, as returned by Datascript `:block/name`).
 */
export const getAllGraphTags = async (): Promise<string[]> => {
  const tags = new Set<string>();

  // 1. Block references: blocks that link to another page (i.e. contain a #tag).
  try {
    const rawBlockRefs = await logseq.DB.datascriptQuery(`
      [:find ?content ?tag (pull ?b [*])
        :where
        [?b :block/refs ?page-ref]
        [?b :block/content ?content]
        [?page-ref :block/name ?tag]
      ]
    `);

    if (Array.isArray(rawBlockRefs)) {
      for (const entry of rawBlockRefs as Array<[string, string, BlockEntity & { 'pre-block?'?: boolean }]>) {
        const [blockContent, tagName, block] = entry;
        if (!blockContent || !tagName) continue;

        const lowerContent = blockContent.toLowerCase();
        // Skip page-property blocks — they're collected via the page-tags query below.
        if (
          block?.['pre-block?'] === true &&
          (lowerContent.includes('tags::') || lowerContent.includes('#+tags:'))
        ) {
          continue;
        }

        // Only count the ref if the block content actually contains the tag inline.
        const escaped = escapeRegExp(tagName);
        if (new RegExp(`#${escaped}|#\\[\\[${escaped}\\]\\]`, 'gi').test(blockContent)) {
          tags.add(tagName);
        }
      }
    }
  } catch (err) {
    console.error('#logseq-ai-auto-tags: block-ref tag query failed', err);
  }

  // 2. Page tags: tags declared via the page-level `tags::` property.
  try {
    const rawPageTags = await logseq.DB.datascriptQuery(`
      [:find ?tag (pull ?page [*])
        :where
        [?page :block/tags ?tag-ref]
        [?tag-ref :block/name ?tag]
      ]
    `);

    if (Array.isArray(rawPageTags)) {
      for (const entry of rawPageTags as Array<[string]>) {
        const [tagName] = entry;
        if (tagName) tags.add(tagName);
      }
    }
  } catch (err) {
    console.error('#logseq-ai-auto-tags: page-tag query failed', err);
  }

  return Array.from(tags);
};

/**
 * Get the code block content of MarkDown.
 * @param markdownText
 * @returns 
 */
export const extractCodeBlockFromMarkdown = (markdownText: string): string => {
  const codeBlockRegex = /```(?:\w+\s)?([\s\S]*?)```/;
  const match = codeBlockRegex.exec(markdownText);
  if (match) {
    return match[1];
  }

  return '';
}

/**
 * @param arr BlockEntity[]
 * @param fn (block: BlockEntity) => void
 */
export const deepFirstTraversal = async (arr: BlockEntity[] | Array<string>, fn: (block: BlockEntity) => void): Promise<void> => {
  // Create an array to store promises for each recursive call
  const promises: Promise<void>[] = [];

  // Use for...of loop to handle asynchronous operations correctly
  for (const obj of arr) {
    const promise = (async () => {
      if (obj instanceof Array && obj[0] === 'uuid') {
        const block = await logseq.Editor.getBlock(obj[1]);
        if (block) {
          fn(block);
          // Recursively call deepFirstTraversal and wait for it to complete
          await deepFirstTraversal((block.children || []) as unknown as Array<string>, fn);
        }
      } else {
        const block = obj as BlockEntity;
        fn(block);
        // Recursively call deepFirstTraversal and wait for it to complete
        await deepFirstTraversal((block.children || []) as unknown as Array<string>, fn);
      }
    })();

    promises.push(promise);
  }

  // Wait for all promises to resolve before resolving the main promise
  await Promise.all(promises);
};

