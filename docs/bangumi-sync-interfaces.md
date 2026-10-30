# Implementation interfaces

All Tauri responses use camelCase. Parents own engine/model/commands/migration. Client agent owns `src-tauri/src/bangumi_sync/client.rs`, `credentials.rs` and Cargo credentials feature. Frontend agent owns `src/features/bangumi-sync/*`, SettingsPage/SectionNav, GameDetailPage and App integration. Do not modify each other's files.

## Model shared with client
`Account { id:i64, username:String, nickname:String }` serde camelCase.
`SyncValue { collection_type:Option<i64>, rate:i64, comment:String }` serde `collectionType`, `rate`, `comment`; None means no collection / local unplayed.
`RemoteCollection { subject_id:i64, subject_type:i64, collection_type:i64 (serde rename type), rate:i64, comment:String(default), private:bool(default) }`, `value() -> SyncValue`.

`Client::new(token: &str) -> CmdResult<Client>`; never Debug token.
`async me()->CmdResult<Account>`
`async collections(username:&str)->CmdResult<Vec<RemoteCollection>>`: game-only paginated authenticated GET, max10000, no partial list on failure.
`async collection(username:&str, subject_id:i64)->CmdResult<Option<RemoteCollection>>`: 404=None.
`async validate_game(subject_id:i64)->CmdResult<()>`: GET subject, require type4.
`async write(subject_id:i64,value:&SyncValue,create:bool,private_new:bool,fields:&[String])->CmdResult<()>`: POST if new else PATCH; only selected status/rate/comment; private only on create, never tags. Fields are `status`, `rate`, `comment`. Non-success errors sanitized as `BGM_HTTP_401: ...` etc, never echo token/body. Do not follow credential redirects to another host. No automatic HTTP retries.

`credentials::load()->CmdResult<Option<String>>`, `save(token:&str)->CmdResult<()>`, `delete()->CmdResult<()>`: Windows Credential Manager, target `KoiPage/Bangumi/PersonalAccessToken`; non-Windows clean unsupported result; no real credential writes in tests.

## Tauri commands
- `bangumi_sync_status` -> SyncStatus
- `bangumi_sync_connect {token}` -> SyncStatus (validate then store, default enabled=false)
- `bangumi_sync_disconnect` -> SyncStatus
- `bangumi_sync_configure {enabled,privateNew}` -> SyncStatus
- `bangumi_sync_run {force}` -> SyncReport; force=true manual, false runtime. Engine gates interval/dirty and serializes calls.
- `bangumi_sync_items` -> SyncItem[] (all local games, including unbound)
- `bangumi_sync_profile_get {gameId}` -> SyncItem
- `bangumi_sync_profile_save {gameId,subjectId,enabled,personalRate,personalComment,expectedRevision}` -> SyncItem; full profile values, rate/comment nullable means no local personal value yet. subjectId numeric|null; updates existing games.bangumi_id after validation, no fuzzy matching. 0 rate explicitly clears score.
- `bangumi_sync_resolve {gameId,choice}` -> SyncItem; choice local/remote; records resolution then UI invokes run(force=true).

`SyncStatus {connected:boolean,account:Account|null,enabled:boolean,intervalSeconds:number,privateNew:boolean,lastRunAt:string|null,lastError:string|null,lastReport:SyncReport|null}`
`SyncReport {synced:number,uploaded:number,downloaded:number,conflicts:number,skipped:number,errors:number}`
`SyncItem {revision:number,gameId:number,title:string,subjectId:number|null,enabled:boolean,personalRate:number|null,personalComment:string|null,lastSyncedAt:string|null,error:string|null,conflict:SyncConflict|null}`
`SyncConflict {local:SyncValue,remote:SyncValue,base:SyncValue|null,fields:string[],reason:string}`

## UI
Settings `settings-bangumi-sync`: token password input, official token-generation link https://next.bgm.tv/demo/access-token, validate/save, replace/disconnect, connected account, auto switch default off, private-new switch true, explicit automatic upload notice for status/personal score/short comment, manual run, last report/errors and conflict items (both values, choose local/remote, pause via profile save retaining item values). Never return/read stored token.

Game detail add independent panel in info tab: Bangumi ID, per-game sync switch, My rating integer0..10 and Bangumi short comment distinct from normal rating/notes, save, last sync/conflict. Personal null untouched must remain null on save unless edited; 0 is explicit unrated. Panel can own own status; don't overwrite unsaved main detail form when remote changes.

Runtime mounted in App: poll run(force=false) every10sec after init ready, backend limits normal network to120sec or dirty; initial run and focus/online trigger okay; in-flight guard/cleanup StrictMode. Listen `bangumi-sync-updated` -> settings/profile refresh, root may bumpPlayTimeRevision for page data. Backend emits event after visible changes; no secret fields. `bangumi-sync-config-changed` -> immediate runtime tick. Backend hooks mark_dirty after game create/update/batch changes; runtime does not require frontend mutation monkeypatches. Avoid unconditional main-form reload while dirty; profile panel refresh only.

Final concurrency additions: bangumi_sync_pause {gameId} returns SyncItem and updates enabled/revision only; profile_save validates optional expectedRevision inside its transaction. App/detail refresh on reports with downloads or errors to expose partial successes.
