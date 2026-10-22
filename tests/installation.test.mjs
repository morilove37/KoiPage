import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivedGameIds, matchesInstallation } from '../src/features/installation/model.ts';

test('only explicit archive settings mark valid game ids as uninstalled', () => {
 assert.deepEqual(archivedGameIds([{key:'game_archived:1',value:'true'},{key:'game_archived:2',value:'false'},{key:'game_archived:-1',value:'true'},{key:'game_archived:3',value:null},{key:'other:4',value:'true'},{key:'game_archived:05',value:'true'}]), {1:true});
});
test('installation filtering preserves archived entries in all and isolates installed entries', () => {
 assert.equal(matchesInstallation('all',true),true);
 assert.equal(matchesInstallation('installed',true),false);
 assert.equal(matchesInstallation('archived',false),false);
 assert.equal(matchesInstallation('archived',true),true);
 assert.equal(matchesInstallation('installed',false),true);
});
