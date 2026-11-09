# Family Agenda Matrix plugin

The Matrix Source Type (`matrix`) of [Family Agenda](https://github.com/artkoenig/family-agenda) as a singleton plugin container, with Synapse and one bridge per Messenger as companions.

## Licence

AGPLv3 (`LICENSE`). Contributions are licensed inbound as outbound under the [Developer Certificate of Origin](https://developercertificate.org/): sign off every commit (`git commit -s`). See `CONTRIBUTING.md`.

## Running it

Add it to the `plugins.yml` of a Family Agenda Instance as in [`plugins.example.yml`](plugins.example.yml): the plugin, Synapse and one bridge per Messenger (WhatsApp so far) as companions. Pin every image.

- The plugin keeps the secrets in its own volume, which no companion mounts, and writes each companion's configuration into a volume shared with that companion alone, so a bridge never reads Synapse's secrets. It keeps the secrets on later starts, writing them atomically; a corrupt `secrets.json` stops the plugin instead of being replaced. Each companion waits up to five minutes for `/config/ready` in its volume.
- Synapse has federation and registration off; the plugin creates one Matrix user per Source with the registration shared secret. Its database comes from `database: true`.
- Each bridge reaches its Messenger only through the egress proxy; the plugin itself has no egress.
- A Messenger whose companion is missing is listed as not installed; while it starts, a run is a temporary error and the login step waits. A companion that has not answered for ten minutes, or a Synapse that refuses the shared secret, is a definite error.
- Removing a Source logs its account out of the bridge.
- Errors reach the core with generic messages only; the details, and texts of the bridge such as a logout reason, are logged.

## Development

`pnpm check` typechecks and runs the tests, including the contract harness of the plugin kit against the plugin in-process, with a fake homeserver and bridge. Pushing a tag `v<version of package.json>` publishes the image to `ghcr.io/artkoenig/family-agenda-matrix` for amd64 and arm64.
