# Troubleshooting

| Symptom                                  | Fix                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `config.yml not found`                   | Run `agent-bridge init` from the repo root                                                   |
| `Source '<name>' has no domains`         | Add `domains:` to that source (or a top-level `domains:` list) in `config.yml`               |
| Source clone failed                      | Check the URL and your SSH/HTTPS credentials; try `git clone <url>` by hand                   |
| `Local source path does not exist`       | Paths must be absolute. Re-run `init` or fix the path in `config.yml`                        |
| `Duplicate "<name>"`                     | Two sources/domains provide the same feature; rename one or narrow with `include`             |
| `Conflict: "<path>" exists as a real file or directory` | You already have a folder with that name. Rename or remove it, then re-run `sync`  |
| `init` shows no domains                  | The source has no top-level folders. Layout must be `<domain>/<feature-type>/<feature>`        |
| A skill I expect doesn't appear          | Check the domain's `include` list, and that the feature type isn't `<othertool>--` prefixed    |
| Git hooks not installed                  | `init` only installs hooks inside a Git repository                                            |
| Hooks skipped                            | Existing foreign hooks are kept. Use `init --force` or integrate manually (see [CLI Reference](CLI-Reference.md)) |
| Hooks seem not to run                    | Look at `.agent-bridge/hook.log`                                                              |
| `init`/`sync` do nothing and exit 0      | `.agent-bridge/optout` is present. Delete it or run `init --force`                            |
| Remove Agent Bridge from a repo          | `agent-bridge opt-out`                                                                        |

Still stuck? Open an issue at <https://github.com/sofatutor/agent-bridge/issues> with the output of the failing command.
