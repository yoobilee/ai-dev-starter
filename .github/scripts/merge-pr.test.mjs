import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const fakeGh = `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const mode=process.env.STARTER_TEST_MODE;
const title='fix: 한글 제목 "인용"과 $(명령) 보존';
fs.appendFileSync(process.env.STARTER_TEST_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='pr'&&args[1]==='checks') {
  if(mode==='ci-failure')process.exit(1);
} else if(args[0]==='pr'&&args[1]==='merge') {
  if(args[args.indexOf('--subject')+1]!==title)process.exit(2);
  if(fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8')!=='본문\\nCloses #7')process.exit(3);
  fs.writeFileSync(process.env.STARTER_TEST_MERGED,'yes');
} else if(args[0]==='api') {
  if(args[1].endsWith('/pulls/1'))console.log(JSON.stringify({state:'open',draft:false,title,body:'본문\\nCloses #7',head:{sha:'a'.repeat(40)},merged:fs.existsSync(process.env.STARTER_TEST_MERGED),merge_commit_sha:'b'.repeat(40)}));
  else if(args[1].endsWith('/status'))console.log(JSON.stringify({statuses:[{context:'independent-review',state:mode==='gate-failure'?'failure':'success'}]}));
  else if(args[1].includes('/commits/'))console.log(JSON.stringify({commit:{message:mode==='bad-subject'?'Merge pull request #1':title+'\\n\\nCloses #7'}}));
  else process.exit(4);
} else process.exit(5);
`;

function run(mode) {
  const dir=mkdtempSync(join(tmpdir(),'starter-merge-test-'));
  try {
    writeFileSync(join(dir,'gh'),fakeGh,{mode:0o755});
    const log=join(dir,'commands.jsonl');
    const result=spawnSync(process.execPath,[new URL('./merge-pr.mjs',import.meta.url).pathname,'owner/repo','1','squash'],{
      encoding:'utf8',env:{...process.env,PATH:dir+delimiter+process.env.PATH,STARTER_TEST_MODE:mode,STARTER_TEST_LOG:log,STARTER_TEST_MERGED:join(dir,'merged')},
    });
    return {result,calls:readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)};
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('한글·따옴표·셸 기호 인수와 Issue 연결 본문 보존',()=>{
  const {result,calls}=run('success');
  assert.equal(result.status,0,result.stderr);
  const merge=calls.find(args=>args[0]==='pr'&&args[1]==='merge');
  assert.equal(merge[merge.indexOf('--match-head-commit')+1],'a'.repeat(40));
});

test('CI 또는 독립 게이트 실패면 병합 명령 미호출',()=>{
  for(const mode of ['ci-failure','gate-failure']) {
    const {result,calls}=run(mode);
    assert.equal(result.status,1);
    assert.equal(calls.some(args=>args[0]==='pr'&&args[1]==='merge'),false);
  }
});

test('저장 제목 불일치면 사후 실패이며 재병합하지 않음',()=>{
  const {result,calls}=run('bad-subject');
  assert.equal(result.status,1);
  assert.match(result.stderr,/사후 검증이 실패/);
  assert.equal(calls.filter(args=>args[0]==='pr'&&args[1]==='merge').length,1);
});
