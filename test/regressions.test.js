'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function harness(env = {}, launch = async () => { throw Error('unexpected launch'); }) {
  const apps = [];
  function express() {
    const app = { routes: [], disable(){}, set(){}, use(fn){this.routes.push(fn);}, get(){}, post(){}, patch(){}, listen(){this.listening=true; return {on(){},close(){}};} };
    apps.push(app); return app;
  }
  express.json = express.urlencoded = () => () => {};
  const deps = { express, 'express-rate-limit': () => () => {}, fs: {existsSync:()=>false}, path,
    undici:{ProxyAgent:class {}}, 'puppeteer-extra':{addExtra:()=>({use(){},launch})},
    'puppeteer-core':{}, 'puppeteer-extra-plugin-stealth':()=>({}) };
  const context = vm.createContext({require:n=>{if (!(n in deps)) throw Error(n); return deps[n];},
    process:{env, cwd:()=>'/synthetic', on(){}, uptime:()=>0, memoryUsage:()=>({}),version:'test'},
    console:{log(){},warn(){},error(){}}, URL, setTimeout, clearTimeout, AbortController});
  vm.runInContext(source, context);
  return {apps, run:code=>vm.runInContext(code,context),context};
}
function response() {return {statusCode:null,setHeader(){},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;},type(){return this;},send(x){this.body=x;return this;}};}

test('#1 confines destinations to API origin and base path', () => {
  const h=harness();
  for (const input of ['https://outside.example.invalid/item','../outside','http://[invalid']) {
    h.context.input=input;
    assert.throws(()=>h.run('buildTargetUrl({originalUrl:input})'),e=>e.statusCode===400);
  }
  assert.equal(h.run("buildTargetUrl({originalUrl:'/api/v1/shortcuts/1'})"),'https://routinehub.co/api/v1/shortcuts/1');
});
test('#2 preserves all question marks in query values',()=>{
  assert.equal(harness().run("buildTargetUrl({originalUrl:'/shortcuts?value=a?b?c'})"),'https://routinehub.co/api/v1/shortcuts?value=a?b?c');
});
test('#3 malformed URL receives controlled client response',async()=>{
  const h=harness(),res=response();
  await h.apps[0].routes.at(-1)({method:'GET',originalUrl:'http://[invalid'},res);
  assert.equal(res.statusCode,400); assert.equal(res.body.code,'INVALID_API_PATH');
});
test('#4 browser HTTP and non-JSON failures are not cached as success',async()=>{
  for(const [status,body] of [[500,'{"error":"synthetic"}'],[404,'not found'],[200,'<html>bad</html>']]) {
    let closed=0;
    const page={setDefaultNavigationTimeout(){},setDefaultTimeout(){},async setUserAgent(){},async setRequestInterception(){},on(){},
      async goto(){return {status:()=>status,headers:()=>({})};},async content(){return body;},async evaluate(){return body;},async close(){closed++;}};
    const h=harness({DIRECT_FETCH_FIRST:'false'},async()=>({connected:true,on(){},async newPage(){return page;},async close(){}}));
    const res=response();await h.apps[0].routes.at(-1)({method:'GET',originalUrl:'/shortcuts'},res);
    assert.equal(res.statusCode,status>=400?status:502);assert.equal(h.run('responseCache.size'),0);assert.equal(closed,1);
  }
});
test('#5 management refresh preserves successful and failed action output',async()=>{
  const h=harness(); const elements=new Map();
  const document={getElementById(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',addEventListener(type,fn){this[type]=fn;}});return elements.get(id);}};
  const status=h.run('getManageStatus()'); let fail=false;
  const ctx=vm.createContext({document,fetch:async url=>({ok:!fail||url==='/api/status',json:async()=>url==='/api/status'?status:fail?{error:'synthetic validation'}:{preview:'unique result'}})});
  vm.runInContext(h.run('manageScript()'),ctx);await new Promise(setImmediate);
  await elements.get('test-form').submit({preventDefault(){}});
  assert.match(elements.get('result').textContent,/unique result/);
  fail=true;await elements.get('settings-form').submit({preventDefault(){}});
  assert.match(elements.get('result').textContent,/synthetic validation/);
});
test('#6 and #7 preserve HTTPS and accept HTTP(S) default ports in both parsers',()=>{
  const h=harness();
  for (const input of ['https://example.invalid:8443','https://example.invalid:443','http://example.invalid:80']) {
    h.context.input=input;
    for(const expr of ['normalizeOptionalProxyUrl(input,"OUTBOUND_PROXY_URL")','normalizeProxyUrl(input)'])assert.equal(h.run(expr),new URL(input).toString());
  }
  assert.equal(h.run("normalizeProxyUrl('http://example.invalid:99999')"),null);
});
test('#8 settings retire pools and await graceful in-flight drain',async()=>{
  const h=harness();let close=0,finish;
  h.context.pool={close(){close++;return new Promise(r=>finish=r);}};
  h.run("fetchDispatchers.set('old',pool)");
  let done=false;const pending=h.run("applySettings({...settings,OUTBOUND_PROXY_URL:'http://example.invalid:80'})").then(()=>done=true);
  await Promise.resolve(); assert.equal(close,1);assert.equal(h.run('fetchDispatchers.size'),0);assert.equal(done,false);
  finish();await pending;assert.equal(done,true);
});
test('#9 reset closes obsolete pending launch without clobbering replacement',async()=>{
  const resolvers=[]; const h=harness({},()=>new Promise(r=>resolvers.push(r)));
  const first=h.run('initBrowser()'); const rejected=assert.rejects(first,/invalidated/);
  await h.run('resetBrowser()'); const next=h.run('initBrowser()');let oldClosed=0;
  resolvers[0]({connected:true,on(){},async close(){oldClosed++;}});await rejected;
  const replacement={connected:true,on(){},async close(){}};resolvers[1](replacement);
  assert.equal(await next,replacement);assert.equal(oldClosed,1);assert.equal(h.run('browser'),replacement);
});
test('#10 management is disabled without token, including public bind override',()=>{
  for(const env of [{},{MANAGE_ENABLED:'true',MANAGE_HOST:'0.0.0.0'}]) {
    const h=harness(env);assert.equal(h.apps.length,1);assert.equal(h.run('MANAGE_ENABLED'),false);
  }
  assert.equal(harness({MANAGE_TOKEN:'synthetic-test-token'}).apps.length,2);
});
test('#11 generated updater retries failed install at matching HEAD and marks only success',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-updater-test-'));
  try {
    fs.mkdirSync(path.join(dir,'.git'));
    let body=fs.readFileSync(path.join(__dirname,'../scripts/deploy-gcp.sh'),'utf8').split('<<EOF_UPDATE\n')[1].split('\nEOF_UPDATE')[0];
    body=body.replace(/\\\$/g,'$').replace('exec 9>/run/${APP_NAME}-update.lock','exec 9>"${APP_DIR}/lock"');
    const stubs=`git() { case "$*" in *'rev-parse HEAD'*) cat "$APP_DIR/head";; *'rev-parse origin/'*) echo new;; *'reset --hard'*) echo new >"$APP_DIR/head";; esac; }
flock() { :; }
logger() { :; }
chown() { :; }
sudo() { echo install >>"$APP_DIR/actions"; if [[ ! -e "$APP_DIR/allow" ]]; then return 42; fi; }
systemctl() { echo restart >>"$APP_DIR/actions"; }
`;
    body=body.replace('cd "${APP_DIR}"',stubs+'\ncd "${APP_DIR}"');
    const file=path.join(dir,'updater');fs.writeFileSync(file,body);fs.writeFileSync(path.join(dir,'head'),'old\n');
    const run=()=>spawnSync('bash',[file],{env:{...process.env,APP_DIR:dir,APP_NAME:'synthetic',APP_USER:'synthetic',BRANCH:'main'},encoding:'utf8'});
    assert.equal(run().status,42);assert.equal(fs.readFileSync(path.join(dir,'head'),'utf8').trim(),'new');
    assert.equal(fs.existsSync(path.join(dir,'.git/rh-proxy-deployed')),false);
    fs.writeFileSync(path.join(dir,'allow'),'');assert.equal(run().status,0);
    assert.equal(fs.readFileSync(path.join(dir,'.git/rh-proxy-deployed'),'utf8').trim(),'new');
    const actions=fs.readFileSync(path.join(dir,'actions'),'utf8');assert.match(actions,/restart/);
    assert.equal(run().status,0);assert.equal(fs.readFileSync(path.join(dir,'actions'),'utf8'),actions);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
