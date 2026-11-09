# Family Agenda Matrix plugin

The Matrix Source Type (`matrix`) of [Family Agenda](https://github.com/artkoenig/family-agenda) as a singleton plugin container, with Synapse and one bridge per Messenger as companions.

## Licence

AGPLv3 (`LICENSE`). Contributions are licensed inbound as outbound under the [Developer Certificate of Origin](https://developercertificate.org/): sign off every commit (`git commit -s`). See `CONTRIBUTING.md`.

## Running it

Add it to the `plugins.yml` of a Family Agenda Instance as in [`plugins.example.yml`](plugins.example.yml): the plugin, Synapse and one bridge per Messenger (WhatsApp so far) as companions. Pin every image.

- The plugin writes the configuration and secrets of Synapse and the bridges into the shared `config` volume when it starts, and keeps them on later starts. The companions wait for `/config/ready`.
- Synapse has federation and registration off; the plugin creates one Matrix user per Source with the registration shared secret. Its database comes from `database: true`.
- Each bridge reaches its Messenger only through the egress proxy; the plugin itself has no egress.
- A Messenger whose companion is missing is listed as not installed; while it starts, a run is a temporary error and the login step waits.
- Removing a Source logs its account out of the bridge.
- Errors reach the core with generic messages only; the details are logged.

## Development

`pnpm check` typechecks and runs the tests, including the contract harness of the plugin kit against the plugin in-process, with a fake homeserver and bridge. Pushing a tag `v<version of package.json>` publishes the image to `ghcr.io/artkoenig/family-agenda-matrix` for amd64 and arm64.
