export const INSERT_PART_MENTION_EVENT = "sfab-insert-part-mention";

export type PartMention = {
  id: string;
  name: string;
};

export function requestInsertPartMention(item: PartMention) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PartMention>(INSERT_PART_MENTION_EVENT, { detail: item })
  );
}
