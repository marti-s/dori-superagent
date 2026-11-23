# Contributing

Thanks for looking. This repository is a small, strict codebase; a change lands when it is one concern, it has evidence, and every gate is green.

## Sign the CLA before we review

Every contributor signs the [Contributor License Agreement](CLA.md) once, before a pull request of theirs can be reviewed or merged. Comment on your pull request with exactly:

```
I have read the CLA Document and I hereby sign the CLA
```

The CLA Assistant workflow then records your signature and the check turns green; it never asks again. Signing is what lets the project keep one licence for every contribution, including the relicensing rights the project needs when it changes its licence — the [licence](LICENSE) is the Sustainable Use License, and the CLA is what makes future licence changes possible without hunting down every author.

## Run the gates

```sh
bun install --frozen-lockfile
(cd skills/dori-mode/scripts && bun install --frozen-lockfile)
bun run ci
```

`bun run ci` is the same chain CI runs:

- `check` — Biome lint and format.
- `typecheck` — `tsc --noEmit` for the harness and for the skill's scripts.
- `knip` — no unused files, exports or dependencies.
- `lint:loc` — the file-length check, against `scripts/loc-baseline.json` (a file may not grow past its baseline).
- `test` — the harness suite.
- `test:skill` — the skill's script suite.

The unit suites need `bun` and `git`, run offline, and use recorded stand-ins for `hc`, `herdr-app` and `gh`. `test/e2e-hc.test.ts` starts a real hc core in an isolated session and is skipped when `hc` is not on `PATH`.

## A pull request

- One concern per pull request, with a title that says what changed and a body that says why.
- Evidence, not adjectives: the command you ran and what it printed, or the file and line you read. A claim you did not verify is written as unverified.
- Tests where behaviour changed; a test that cannot fail is not a test.
- Public surfaces — issues, pull requests, commits, review comments — are English.
- Do not edit another person's work to make your change pass; report it instead.

## Licence

The project is licensed under the [Sustainable Use License](LICENSE), with third-party components under their own licences. By contributing you agree your contribution is licensed under the same terms, as set out in the [CLA](CLA.md).
