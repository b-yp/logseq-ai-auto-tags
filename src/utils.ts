export const extractCodeBlockFromMarkdown = (markdownText: string): string => {
  const codeBlockRegex = /```([\s\S]*?)```/;

  const match = codeBlockRegex.exec(markdownText);
  if (match) {
    return match[1];
  }

  return '';
}