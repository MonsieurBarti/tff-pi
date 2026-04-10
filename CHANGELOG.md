# Changelog

## 1.0.0 (2026-04-10)


### Features

* add /tff new command handler ([70779c6](https://github.com/MonsieurBarti/tff-pi/commit/70779c6db984a4541e3b3369771046570ff53fbe))
* add /tff status and /tff progress commands ([4da46aa](https://github.com/MonsieurBarti/tff-pi/commit/4da46aa425d937d5319813871abff582148299a3))
* add artifact directory management and settings module ([e72354e](https://github.com/MonsieurBarti/tff-pi/commit/e72354eb7bec8cc054b143829c10224cf7d0fb83))
* add compressed agent identity and protocol prompts for design phases ([06d2d10](https://github.com/MonsieurBarti/tff-pi/commit/06d2d10993c2e46c49785f356a4e805864b26dd7))
* add db helpers, wave computation, dispatch and review utilities ([26d0c84](https://github.com/MonsieurBarti/tff-pi/commit/26d0c845c79245134e76c131d8681f47a2e14c2c))
* add discuss, research, plan command validators ([091fdcb](https://github.com/MonsieurBarti/tff-pi/commit/091fdcbfcae5c596a73496ca58b691cea9b608a3))
* add entity types and state constants ([5805424](https://github.com/MonsieurBarti/tff-pi/commit/5805424329065f0d1f17a5e9018a9f0995d60b42))
* add git root detection and branch helpers ([83e8859](https://github.com/MonsieurBarti/tff-pi/commit/83e88595208e524c9a1bc3f6ddfc79ee48d822ca))
* add new-milestone command with auto-increment and directory setup ([3bc32c2](https://github.com/MonsieurBarti/tff-pi/commit/3bc32c26c1ba57468ba01f29c44c85e532fa12b3))
* add next, auto, pause commands for orchestrator control ([18ffc0f](https://github.com/MonsieurBarti/tff-pi/commit/18ffc0f6f56de3a52d5a9d59147fbe9fdd9244ed))
* add orchestrator spine with phase routing and dispatch ([4874999](https://github.com/MonsieurBarti/tff-pi/commit/487499922354704e1a0816ab8cf9c7d10a5b21b0))
* add sqlite database module with crud operations ([3a4355f](https://github.com/MonsieurBarti/tff-pi/commit/3a4355f5d8286caf87e6aff738cb3a92ed44266f))
* add state machine with transitions and guards ([192766f](https://github.com/MonsieurBarti/tff-pi/commit/192766f9103c215c5cfc29a258aebf49aa15dd92))
* add subcommand router for /tff command ([f554eea](https://github.com/MonsieurBarti/tff-pi/commit/f554eea2d70aa9ca883ab68b77e5c564486d94f9))
* add tff_create_slice tool for ad-hoc slice creation ([28626eb](https://github.com/MonsieurBarti/tff-pi/commit/28626eb06cdfef81b5605cd3c4056023117d25eb))
* add tff_query_state ai tool ([aa9d7c4](https://github.com/MonsieurBarti/tff-pi/commit/aa9d7c450474ef628ffa8524870bd70df0eeb8c0))
* add tff_write_spec, tff_write_research, tff_write_plan tools ([77543af](https://github.com/MonsieurBarti/tff-pi/commit/77543af7c9fe7453452fc28486f42b505732eeb2))
* m01 foundation — core infrastructure ([6047e33](https://github.com/MonsieurBarti/tff-pi/commit/6047e33d2b2c95f2fc989033810926fafd3fef4c))
* m02 design phases ([0092f0c](https://github.com/MonsieurBarti/tff-pi/commit/0092f0c8c1383f57090de3925e131c84ce982829))
* wire extension entry point with command router and ai tools ([deac804](https://github.com/MonsieurBarti/tff-pi/commit/deac804365011e95c7ce65465154395616067c9b))
* wire m02 commands and tools into extension entry point ([295c984](https://github.com/MonsieurBarti/tff-pi/commit/295c984aec7b1aaee23931455b99202b5dcbacbe))


### Bug Fixes

* address review findings — double transition, timeout, verification, retry, plan validation ([3019a94](https://github.com/MonsieurBarti/tff-pi/commit/3019a946375e5ff2b5f19af28fae95d79d75b3d7))
* align release-please config to prevent 1.0.0 initial release ([8cd8001](https://github.com/MonsieurBarti/tff-pi/commit/8cd80011e63c6538ce1fbe88d282d1a1ef7b7ad0))
* configure git identity in test setup for ci compatibility ([c5186c6](https://github.com/MonsieurBarti/tff-pi/commit/c5186c637d86e0d375e8e25f6e1b57b3ff58cddf))
* convert workflow yaml from tabs to spaces, add typecheck to pre-commit ([ce25e95](https://github.com/MonsieurBarti/tff-pi/commit/ce25e9518a52feaeb9dca47040e97dfdd029372b))
* copy resources to dist during build, ignore coverage in biome ([40ddac2](https://github.com/MonsieurBarti/tff-pi/commit/40ddac2f5824d568c6c60086305cea00b7ec75d8))
* only s-tier skips research phase, not ss/sss ([746ec8c](https://github.com/MonsieurBarti/tff-pi/commit/746ec8cf21ce234707c21768a27eb0b80142b30a))
* untrack docs/ directory, should be gitignored ([f489d1e](https://github.com/MonsieurBarti/tff-pi/commit/f489d1efee65a512f8affdcbcdb54072fc504787))
