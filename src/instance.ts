/** How the plugin reaches the homeserver and the bridges, its companion containers. */
export type MatrixInstance = {
  homeserver: {
    /** The address of Synapse on the plugin's internal network, such as `http://plugin-matrix-synapse:8008`. */
    url: string;
    /** The name in the homeserver's user ids, such as `family-agenda.local`. */
    serverName: string;
    /** Lets the plugin create a Matrix user for each Source while registration is off. */
    registrationSharedSecret: string;
  };
  /** By Messenger id: its bridge's address and the secret of its provisioning API. */
  bridges: Record<string, { url: string; provisioningSecret: string }>;
};
