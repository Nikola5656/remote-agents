const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('worker service config preserves quoted credentials and leaves built-in fleet enabled', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ra installer ' "));
  try {
    const root=path.join(dir,'repo'),home=path.join(dir,'home');fs.mkdirSync(root);
    const token='test-token-"""-with-\\backslash-and-$literal';
    fs.writeFileSync(path.join(root,'.env'),`SERVER_URL=https://example.test\nWORKER_TOKEN=${token}\nWORKER_DATA_DIR=\nWORKSPACES_ROOT=\nAGENT_FLEET_FILE=\n`);
    const dest=path.join(dir,'worker.plist');
    const run=spawnSync('python3',[path.join(__dirname,'../apps/worker/scripts/worker-env.py'),'write-plist','--root',root,'--home',home,'--dest',dest,'--label','test.worker','--node',process.execPath,'--worker-js',path.join(root,'index.js'),'--log-dir',path.join(home,'logs')],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:os.homedir()}});
    assert.equal(run.status,0,run.stderr);
    const parsed=spawnSync('python3',['-c','import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',dest],{encoding:'utf8'});
    assert.equal(parsed.status,0,parsed.stderr);const env=JSON.parse(parsed.stdout).EnvironmentVariables;
    assert.equal(env.WORKER_TOKEN,token);assert.equal(env.AGENT_FLEET_FILE,'');
    assert.equal(env.WORKER_DATA_DIR,path.join(home,'.local/share/remote-agents-worker'));
    assert.ok(fs.existsSync(env.WORKSPACES_ROOT));assert.equal(fs.statSync(dest).mode&0o777,0o600);
    assert.ok(!run.stdout.includes(token));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('service installers reject missing Python before creating state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-no-python-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const dirname = spawnSync('which', ['dirname'], {encoding:'utf8'}).stdout.trim();
    fs.symlinkSync(dirname, path.join(bin, 'dirname'));
    for (const script of ['apps/worker/scripts/install-linux.sh', 'apps/worker/scripts/install-macos.sh', 'deploy/install-server.sh']) {
      const dest=path.join(dir,'state');
      const run=spawnSync('/bin/bash',[path.join(__dirname,'..',script),path.join(__dirname,'..')],{encoding:'utf8',env:{PATH:bin,HOME:dir,RA_SERVER_INSTALL_ROOT:dest,WORKER_DATA_DIR:dest}});
      assert.notEqual(run.status,0,script);
      assert.match(run.stderr,/Python 3 is required/,script);
      assert.ok(!fs.existsSync(dest),script);
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('LaunchAgent upgrades preserve existing identity and reject duplicate or conflicting labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-launchd-label-'));
  const root = path.join(dir, 'repo'), home = path.join(dir, 'home');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(root); fs.mkdirSync(launchAgents, {recursive:true});
  const script = path.join(__dirname, '../apps/worker/scripts/worker-env.py');
  const environment = {PATH:process.env.PATH, HOME:home};
  const resolve = (overrides={}) => spawnSync('python3', [script, 'launch-agent-label', '--root', root, '--home', home], {encoding:'utf8', env:{...environment,...overrides}});
  const plist = (label, workerRoot=root) => {
    const result = spawnSync('python3', ['-c', 'import plistlib,sys; plistlib.dump({"Label":sys.argv[2],"ProgramArguments":["node",sys.argv[3]]},open(sys.argv[1],"wb"))', path.join(launchAgents,label+'.plist'),label,path.join(workerRoot,'apps/worker/dist/index.js')],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  };
  try {
    assert.equal(resolve().stdout.trim(),'com.remote-agents.worker');
    fs.writeFileSync(path.join(root,'.env'),'WORKER_LAUNCH_AGENT_LABEL=org.example.worker\n');
    assert.equal(resolve().stdout.trim(),'org.example.worker');
    assert.equal(resolve({WORKER_LAUNCH_AGENT_LABEL:'org.example.override'}).stdout.trim(),'org.example.override');
    assert.notEqual(resolve({WORKER_LAUNCH_AGENT_LABEL:'../unsafe'}).status,0);
    fs.unlinkSync(path.join(root,'.env'));
    plist('org.example.unrelated',path.join(dir,'different-repo'));
    assert.equal(resolve().stdout.trim(),'com.remote-agents.worker');
    plist('org.example.previous');
    assert.equal(resolve().stdout.trim(),'org.example.previous');
    const conflict=resolve({WORKER_LAUNCH_AGENT_LABEL:'org.example.renamed'});
    assert.notEqual(conflict.status,0);assert.match(conflict.stderr,/uninstall the existing service/);
    plist('org.example.duplicate');
    assert.match(resolve().stderr,/Multiple LaunchAgents/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('worker service PATH can be configured without modifying installer source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-worker-path-'));
  try {
    const home=path.join(dir,'home'), dest=path.join(dir,'worker.env');
    fs.writeFileSync(path.join(dir,'.env'),'WORKER_PATH=/custom/tools:/usr/bin\n');
    const result=spawnSync('python3',[path.join(__dirname,'../apps/worker/scripts/worker-env.py'),'write-env-file','--root',dir,'--home',home,'--env-file',dest],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:home}});
    assert.equal(result.status,0,result.stderr);
    assert.match(fs.readFileSync(dest,'utf8'),/^PATH=\/custom\/tools:\/usr\/bin$/m);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});


test('server upgrades retain old hashed chunks while updating HTML and removing unhashed assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra web upgrade '));
  try {
    const source = path.join(dir, 'source'), dest = path.join(dir, 'dest');
    const assets = (root) => path.join(root, 'apps/web/dist/assets');
    for (const root of [source, dest]) fs.mkdirSync(assets(root), {recursive: true});
    fs.writeFileSync(path.join(dest, 'apps/web/dist/index.html'), 'old HTML');
    fs.writeFileSync(path.join(source, 'apps/web/dist/index.html'), 'new release HTML');
    fs.writeFileSync(path.join(assets(dest), 'MarkdownViewer-Ab_cd--9.js'), 'old chunk');
    fs.writeFileSync(path.join(assets(dest), 'index-A1B2C3D4.css'), 'old styles');
    fs.writeFileSync(path.join(assets(dest), 'unhashed.js'), 'obsolete');
    fs.writeFileSync(path.join(assets(dest), 'private.txt'), 'obsolete');
    fs.writeFileSync(path.join(assets(source), 'MarkdownViewer-1234_-ab.js'), 'new chunk');
    const run = spawnSync('bash', ['-c', 'source "$1"; preserve_hashed_web_assets "$3"; rsync -a --delete ${rsync_preserve_web_assets[@]+"${rsync_preserve_web_assets[@]}"} "$2/" "$3/"', 'asset-upgrade', path.join(__dirname, '../deploy/install-lib.sh'), source, dest], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(path.join(dest, 'apps/web/dist/index.html'), 'utf8'), 'new release HTML');
    assert.equal(fs.readFileSync(path.join(assets(dest), 'MarkdownViewer-Ab_cd--9.js'), 'utf8'), 'old chunk');
    assert.equal(fs.readFileSync(path.join(assets(dest), 'index-A1B2C3D4.css'), 'utf8'), 'old styles');
    assert.equal(fs.readFileSync(path.join(assets(dest), 'MarkdownViewer-1234_-ab.js'), 'utf8'), 'new chunk');
    assert.equal(fs.existsSync(path.join(assets(dest), 'unhashed.js')), false);
    assert.equal(fs.existsSync(path.join(assets(dest), 'private.txt')), false);
    const installer = fs.readFileSync(path.join(__dirname, '../deploy/install-server.sh'), 'utf8');
    assert.match(installer, /preserve_hashed_web_assets "\$DEST"/);
    assert.ok(installer.includes('"${rsync_preserve_web_assets[@]}"'));
    const fresh = path.join(dir, 'fresh'); fs.mkdirSync(fresh);
    const firstInstall = spawnSync('bash', ['-c', 'source "$1"; preserve_hashed_web_assets "$3"; rsync -a --delete ${rsync_preserve_web_assets[@]+"${rsync_preserve_web_assets[@]}"} "$2/" "$3/"', 'asset-install', path.join(__dirname, '../deploy/install-lib.sh'), source, fresh], {encoding: 'utf8'});
    assert.equal(firstInstall.status, 0, firstInstall.stderr);
    assert.equal(fs.readFileSync(path.join(fresh, 'apps/web/dist/index.html'), 'utf8'), 'new release HTML');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
