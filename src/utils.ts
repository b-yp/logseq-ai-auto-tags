import { BlockEntity } from "@logseq/libs/dist/LSPlugin.user";

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

