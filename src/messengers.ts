import type { PluginText } from "./texts";

/** A chat network the plugin reads through a bridge on the Instance's homeserver (ADR-0011). */
export type Messenger = {
  id: string;
  displayName: PluginText;
  description: PluginText;
  riskNotice?: PluginText;
  /** The local part of its bridge bot's Matrix user, as `configuration.ts` configures the bridge. */
  botLocalpart: string;
  /** How the local parts of its ghost users start, the Matrix users that stand for the Messenger's users. */
  ghostPrefix: string;
  /** The bridge's login flow that shows a QR code to scan. */
  qrLoginFlow: string;
  /** What to do with the QR code the bridge shows. */
  scanHint: PluginText;
  /** The Messenger's name in every language, such as in the messages shown to the Admin. */
  attributeValue: string;
};

/**
 * The Messengers the plugin supports, each served by one bridge. Adding one is an entry here, its
 * bridge as a companion in `plugins.yml`, and its configuration in `configuration.ts`.
 */
export const messengers: Messenger[] = [
  {
    id: "whatsapp",
    displayName: { en: "WhatsApp", de: "WhatsApp" },
    description: {
      en: "Reads WhatsApp chats through the mautrix-whatsapp bridge, linked as a device of a parent's account by scanning a QR code.",
      de: "Liest WhatsApp-Chats über die Bridge mautrix-whatsapp, die per QR-Code als Gerät des Kontos eines Elternteils verknüpft wird.",
    },
    riskNotice: {
      en: "The bridge is an unofficial WhatsApp client linked as a device. This breaks WhatsApp's terms of service and may get the linked account banned. It only receives: it never sends messages or read receipts. Forwarding mail is the compliant alternative.",
      de: "Die Bridge ist ein inoffizieller WhatsApp-Client, der als Gerät verknüpft wird. Das verstößt gegen die Nutzungsbedingungen von WhatsApp, und das verknüpfte Konto kann gesperrt werden. Sie empfängt nur: Sie sendet nie Nachrichten oder Lesebestätigungen. Weitergeleitete Mails sind die regelkonforme Alternative.",
    },
    botLocalpart: "whatsappbot",
    ghostPrefix: "whatsapp_",
    qrLoginFlow: "qr",
    scanHint: {
      en: "On the phone, open WhatsApp, then Settings, Linked devices, Link a device, and scan this code.",
      de: "Öffne auf dem Handy WhatsApp, dann Einstellungen, Verknüpfte Geräte, Gerät verknüpfen, und scanne diesen Code.",
    },
    attributeValue: "WhatsApp",
  },
];

export function messengerOf(id: unknown): Messenger | undefined {
  return messengers.find((messenger) => messenger.id === id);
}
