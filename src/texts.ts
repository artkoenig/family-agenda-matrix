/** A text shown to an Admin: plain, or per language with English always present. */
export type PluginText = string | ({ en: string } & Record<string, string>);

/** The English of a text. */
export function englishOf(text: PluginText): string {
  return typeof text === "string" ? text : text.en;
}
