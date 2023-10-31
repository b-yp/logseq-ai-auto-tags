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
