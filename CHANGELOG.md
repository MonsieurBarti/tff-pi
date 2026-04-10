# Changelog

## [0.1.1](https://github.com/MonsieurBarti/tff-pi/compare/tff-pi-v0.1.0...tff-pi-v0.1.1) (2026-04-10)


### Features

* add /tff new command handler ([70779c6](https://github.com/MonsieurBarti/tff-pi/commit/70779c6db984a4541e3b3369771046570ff53fbe))
* add /tff status and /tff progress commands ([4da46aa](https://github.com/MonsieurBarti/tff-pi/commit/4da46aa425d937d5319813871abff582148299a3))
* add artifact directory management and settings module ([e72354e](https://github.com/MonsieurBarti/tff-pi/commit/e72354eb7bec8cc054b143829c10224cf7d0fb83))
* add compressed agent identity and protocol prompts for design phases ([cd16895](https://github.com/MonsieurBarti/tff-pi/commit/cd16895e6bdbda6c25e657956beea13de862ca27))
* add db helpers, wave computation, dispatch and review utilities ([f34536f](https://github.com/MonsieurBarti/tff-pi/commit/f34536f080eff48dfb0e4801a57b40e456a7e150))
* add discuss, research, plan command validators ([6c799e1](https://github.com/MonsieurBarti/tff-pi/commit/6c799e10cb7cf5b834604dfcac778f42b75bfdd8))
* add entity types and state constants ([5805424](https://github.com/MonsieurBarti/tff-pi/commit/5805424329065f0d1f17a5e9018a9f0995d60b42))
* add git root detection and branch helpers ([83e8859](https://github.com/MonsieurBarti/tff-pi/commit/83e88595208e524c9a1bc3f6ddfc79ee48d822ca))
* add new-milestone command with auto-increment and directory setup ([2388bd8](https://github.com/MonsieurBarti/tff-pi/commit/2388bd8bcc1909fcc5198468bfe6c6be269dee7e))
* add next, auto, pause commands for orchestrator control ([fae77c2](https://github.com/MonsieurBarti/tff-pi/commit/fae77c21b88c2e7108d4219975f6db1b7eceaa1a))
* add orchestrator spine with phase routing and dispatch ([d8a54ba](https://github.com/MonsieurBarti/tff-pi/commit/d8a54ba2b2429a3c0fa42c6e1c6a8acdf7466a3d))
* add sqlite database module with crud operations ([3a4355f](https://github.com/MonsieurBarti/tff-pi/commit/3a4355f5d8286caf87e6aff738cb3a92ed44266f))
* add state machine with transitions and guards ([192766f](https://github.com/MonsieurBarti/tff-pi/commit/192766f9103c215c5cfc29a258aebf49aa15dd92))
* add subcommand router for /tff command ([f554eea](https://github.com/MonsieurBarti/tff-pi/commit/f554eea2d70aa9ca883ab68b77e5c564486d94f9))
* add tff_create_slice tool for ad-hoc slice creation ([1463b16](https://github.com/MonsieurBarti/tff-pi/commit/1463b169e69fbeac21299bdf04672eb0f8b7db76))
* add tff_query_state ai tool ([aa9d7c4](https://github.com/MonsieurBarti/tff-pi/commit/aa9d7c450474ef628ffa8524870bd70df0eeb8c0))
* add tff_write_spec, tff_write_research, tff_write_plan tools ([b1696ff](https://github.com/MonsieurBarti/tff-pi/commit/b1696ffce8c2257b426fc7b3c21d0bcfe6cc7e85))
* m01 foundation — core infrastructure ([3a1adb4](https://github.com/MonsieurBarti/tff-pi/commit/3a1adb453be99050601a78dc6d22748618a6b27b))
* m02 design phases ([5f6eb0f](https://github.com/MonsieurBarti/tff-pi/commit/5f6eb0f771fd991edfefd5aac4cefb695a96fac0))
* wire extension entry point with command router and ai tools ([deac804](https://github.com/MonsieurBarti/tff-pi/commit/deac804365011e95c7ce65465154395616067c9b))
* wire m02 commands and tools into extension entry point ([f6d4675](https://github.com/MonsieurBarti/tff-pi/commit/f6d46759188b4805a978a81f7a0fd5e25e52b9d5))


### Bug Fixes

* address review findings — double transition, timeout, verification, retry, plan validation ([3d930c0](https://github.com/MonsieurBarti/tff-pi/commit/3d930c09f52f6fa00a2b116a523683725b3cdb05))
* align release-please config to prevent 1.0.0 initial release ([478876a](https://github.com/MonsieurBarti/tff-pi/commit/478876a9922ad861d3a69ab1249db107868f3ec4))
* biome strict mode + release-please manifest ([#5](https://github.com/MonsieurBarti/tff-pi/issues/5)) ([f8ff755](https://github.com/MonsieurBarti/tff-pi/commit/f8ff7554161bbd85da835d62ce5f999ef319026e))
* configure git identity in test setup for ci compatibility ([c5186c6](https://github.com/MonsieurBarti/tff-pi/commit/c5186c637d86e0d375e8e25f6e1b57b3ff58cddf))
* convert workflow yaml from tabs to spaces, add typecheck to pre-commit ([ce25e95](https://github.com/MonsieurBarti/tff-pi/commit/ce25e9518a52feaeb9dca47040e97dfdd029372b))
* copy resources to dist during build, ignore coverage in biome ([49923c6](https://github.com/MonsieurBarti/tff-pi/commit/49923c6534e7b86bca5576832489eb7b6fe6815e))
* only s-tier skips research phase, not ss/sss ([746ec8c](https://github.com/MonsieurBarti/tff-pi/commit/746ec8cf21ce234707c21768a27eb0b80142b30a))
* untrack docs/ directory, should be gitignored ([8c920eb](https://github.com/MonsieurBarti/tff-pi/commit/8c920eb5f0e0b28f4d03e85602425a097d65a118))
