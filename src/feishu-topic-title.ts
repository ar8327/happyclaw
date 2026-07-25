const TOPIC_TITLE_MAX_LENGTH = 40;

function fallbackTopicSuffix(rootMessageId: string): string {
  return rootMessageId.slice(-6);
}

function stripAttachmentMarker(line: string): string {
  return line.replace(/^\s*\[(?:图片|文件)(?::[^\]]*)?\]\s*/u, '').trim();
}

function stripLeadingMention(text: string): string {
  return text.replace(/^@\S+\s*/u, '').trim();
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?)[。！？!?.\n\r]/u);
  return (match?.[1] || text).trim();
}

function compactTopicText(messageText?: string): string {
  if (!messageText) return '';
  const candidate = messageText
    .split(/\r?\n/u)
    .map(stripAttachmentMarker)
    .map(stripLeadingMention)
    .find((line) => line.length > 0);
  if (!candidate) return '';
  return firstSentence(candidate)
    .replace(/\s+/gu, ' ')
    .slice(0, TOPIC_TITLE_MAX_LENGTH)
    .trim();
}

export function buildFeishuTopicNameSuffix(
  rootMessageId: string,
  messageText?: string,
): string {
  return compactTopicText(messageText) || fallbackTopicSuffix(rootMessageId);
}
