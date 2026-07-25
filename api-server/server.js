const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { generateImageBatch } = require('./gemini_imagen.js');
const { assembleShortsVideo } = require('./shorts_engine.js');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(__dirname, '.env');
const PORT = Number(process.env.PORT || readEnv().PORT || 8787);
const TELEMETRY_PATH = path.join(__dirname, 'inkvortex-api-telemetry.jsonl');
const DEFAULT_API_TIMEOUT_MS = 240000;
const STUDIO_VERSION = '8.0';
const ENGINE_VERSION = '3.6';
const SERVER_STARTED_AT = new Date().toISOString();

const DEFAULTS_ROOT = path.join(__dirname, 'defaults');
const LOCAL_WORKSPACE_DIRS = Object.freeze(['fonts','palco','galeria','gpt','gemini','flow','logo-inkvortex','render']);
const LOCAL_FIXED_DEFAULTS = Object.freeze([
  ['gemini/abertura.txt','gemini/abertura.txt'],
  ['logo-inkvortex/logo-inkvortex.png','logo-inkvortex/logo-inkvortex.png']
]);

function ensureDirectory(dir){fs.mkdirSync(dir,{recursive:true});}
function copyFileIfMissing(source,target){
  if(fs.existsSync(target)||!fs.existsSync(source))return false;
  ensureDirectory(path.dirname(target));
  fs.copyFileSync(source,target);
  return true;
}
function uniqueMigrationTarget(target){
  if(!fs.existsSync(target))return target;
  const ext=path.extname(target),base=target.slice(0,-ext.length);let index=2,candidate;
  do{candidate=`${base}-migrado-${index}${ext}`;index+=1;}while(fs.existsSync(candidate));
  return candidate;
}
function migrateFilePreservingUserSource(source,target){
  if(!fs.existsSync(source)||!fs.statSync(source).isFile())return false;
  ensureDirectory(path.dirname(target));
  let finalTarget=target;
  if(fs.existsSync(target)){
    const same=fs.statSync(source).size===fs.statSync(target).size&&fs.readFileSync(source).equals(fs.readFileSync(target));
    if(same){fs.unlinkSync(source);return true;}
    finalTarget=uniqueMigrationTarget(target);
  }
  try{fs.renameSync(source,finalTarget);}catch(error){fs.copyFileSync(source,finalTarget);fs.unlinkSync(source);}
  return true;
}
function walkLegacyFiles(dir,callback,relative=[]){
  if(!fs.existsSync(dir))return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name),parts=[...relative,entry.name];
    if(entry.isDirectory())walkLegacyFiles(full,callback,parts);
    else if(entry.isFile())callback(full,parts);
  }
}
function removeEmptyTree(dir){
  if(!fs.existsSync(dir))return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())removeEmptyTree(path.join(dir,entry.name));
  try{if(fs.readdirSync(dir).length===0)fs.rmdirSync(dir);}catch(error){}
}
function prepareLocalWorkspace(){
  for(const name of LOCAL_WORKSPACE_DIRS)ensureDirectory(path.join(ROOT,name));

  const legacyRoot=path.join(ROOT,'assets-inkvortex');
  if(fs.existsSync(legacyRoot)){
    const legacyLogo=path.join(legacyRoot,'logo-inkvortex.png');
    if(fs.existsSync(legacyLogo))migrateFilePreservingUserSource(legacyLogo,path.join(ROOT,'logo-inkvortex','logo-inkvortex.png'));
    const legacyStage=path.join(legacyRoot,'palco');
    walkLegacyFiles(legacyStage,(source,parts)=>migrateFilePreservingUserSource(source,path.join(ROOT,'palco',...parts)));
    walkLegacyFiles(legacyRoot,(source,parts)=>{
      if(parts[0]==='palco'||/^logo(?:[-_]|\.|$)/i.test(parts[parts.length-1]))return;
      migrateFilePreservingUserSource(source,path.join(ROOT,'galeria',...parts));
    });
    removeEmptyTree(legacyStage);removeEmptyTree(legacyRoot);
  }
  for(const [defaultRelative,localRelative] of LOCAL_FIXED_DEFAULTS)copyFileIfMissing(path.join(DEFAULTS_ROOT,defaultRelative),path.join(ROOT,localRelative));
}

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function writeEnv(updates) {
  const current = readEnv();
  const merged = { ...current, ...updates };
  let content = '';
  for (const [key, value] of Object.entries(merged)) {
    if (value) content += `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}


function env(name, fallback = '') {
  return process.env[name] || readEnv()[name] || fallback;
}
function apiProfileMode(){return String(env('INKVORTEX_API_PROFILE','adaptive')).trim().toLowerCase()==='fixed'?'fixed':'adaptive';}


const STAGE_PROFILES = Object.freeze({
  themes:{label:'Cinco ideias novas',initialOutputTokens:4000,maxOutputTokens:5000,timeoutMs:240000,gemini:{temperature:1.00,thinkingLevel:'high'},mistral:{temperature:0.86,reasoningEffort:'none'}},
  scenes45:{label:'Cinco quadros editoriais estáticos',initialOutputTokens:8000,maxOutputTokens:12000,timeoutMs:240000,gemini:{temperature:1.00,thinkingLevel:'high'},mistral:{temperature:0.74,reasoningEffort:'none'}},
  scenes916:{label:'Cinco cenas de movimento Gemini',initialOutputTokens:8000,maxOutputTokens:12000,timeoutMs:240000,gemini:{temperature:1.00,thinkingLevel:'high'},mistral:{temperature:0.74,reasoningEffort:'none'}},
  caption:{label:'Legenda Social de autoridade',initialOutputTokens:5000,maxOutputTokens:8000,timeoutMs:240000,gemini:{temperature:0.92,thinkingLevel:'high'},mistral:{temperature:0.78,reasoningEffort:'none'}},
  audio:{label:'Roteiro Sinfônico',initialOutputTokens:8000,maxOutputTokens:8192,timeoutMs:240000,gemini:{temperature:1.0,topP:0.95},mistral:{temperature:0.75,reasoningEffort:'none'}},
  flowMaster:{label:'Roteiro Master (Veo)',initialOutputTokens:2048,maxOutputTokens:4096,timeoutMs:60000,gemini:{temperature:0.8,thinkingLevel:'low'},mistral:{temperature:0.7,reasoningEffort:'none'}}
});

const MISTRAL_STAGE_DEFAULT_MODELS = Object.freeze({
  themes:'mistral-small-latest',
  scenes45:'pixtral-large-latest',
  scenes916:'pixtral-large-latest',
  caption:'mistral-small-latest',
  audio:'mistral-large-latest',
  flowMaster:'mistral-small-latest'
});
const MISTRAL_MODEL_FAMILY_FALLBACKS = Object.freeze({
  'mistral-small-2603':['mistral-small-latest'],
  'mistral-small-latest':['mistral-small-2603'],
  'mistral-large-2512':['mistral-large-latest'],
  'mistral-large-latest':['mistral-large-2512'],
  'ministral-8b-latest':['mistral-small-latest'],
  'pixtral-large-latest':['mistral-large-latest'],
  'mistral-large-2411':['mistral-large-latest']
});

function canonicalStageName(taskName) {
  const value=String(taskName||'').toLowerCase();
  if(value.includes('theme')||value.includes('idea'))return 'themes';
  if(value.includes('9:16')||value.includes('916')||value.includes('motion')||value.includes('visual-scenes'))return 'scenes916';
  if(value.includes('4:5')||value.includes('45')||value.includes('static-scenes'))return 'scenes45';
  if(value.includes('caption'))return 'caption';
  return 'scenes45';
}
function resolvedStageProfile(taskName, provider, overrides={}) {
  const stage=overrides.profileName||canonicalStageName(taskName);
  const base=STAGE_PROFILES[stage]||STAGE_PROFILES.scenes45;
  const providerConfig=base[provider]||{};
  return {
    stage,
    label:base.label,
    temperature:Number.isFinite(Number(overrides.temperature))?Number(overrides.temperature):providerConfig.temperature,
    topP:Number.isFinite(Number(overrides.topP))?Number(overrides.topP):providerConfig.topP,
    thinkingLevel:overrides.thinkingLevel||providerConfig.thinkingLevel,
    reasoningEffort:overrides.reasoningEffort||providerConfig.reasoningEffort,
    initialOutputTokens:Number(overrides.initialOutputTokens||overrides.maxOutputTokens||base.initialOutputTokens),
    maxOutputTokens:Number(overrides.tokenCeiling||base.maxOutputTokens),
    timeoutMs:Number(overrides.timeoutMs||base.timeoutMs)
  };
}
function publicStageProfiles(provider=activeProvider()) {
  return Object.fromEntries(Object.keys(STAGE_PROFILES).map(stage=>{
    const profile=resolvedStageProfile(stage,provider,{profileName:stage});
    const publicProfile={label:profile.label,temperature:profile.temperature,initialOutputTokens:profile.initialOutputTokens,maxOutputTokens:profile.maxOutputTokens,timeoutMs:profile.timeoutMs};
    if(provider==='gemini'){
      publicProfile.topP=profile.topP;
      publicProfile.thinkingLevel=profile.thinkingLevel;
    }else{
      const info=activeProviderInfo(stage);
      const supportsReasoning=mistralSupportsAdjustableReasoning(info.model);
      publicProfile.model=info.model;
      publicProfile.modelSource=info.modelSource;
      publicProfile.reasoningEffort=supportsReasoning?normalizeMistralReasoningEffort(profile.reasoningEffort,stage):null;
      publicProfile.reasoningSupportedValues=supportsReasoning?['high','none']:[];
      publicProfile.reasoningMode=supportsReasoning?'adjustable':'disabled_for_model';
    }
    return [stage,publicProfile];
  }));
}

function interactionGenerationConfigFor(config = {}) {
  const generationConfig = {
    temperature: config.temperature,
    top_p: config.topP,
    max_output_tokens: config.maxOutputTokens
  };
  Object.keys(generationConfig).forEach(key => generationConfig[key] === undefined && delete generationConfig[key]);
  return generationConfig;
}
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MISTRAL_MAX_ATTEMPTS = 4;
const MISTRAL_TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

function mistralRetryDelay(attempt, response) {
  const retryAfter = Number(response && response.headers && response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.ceil(retryAfter * 1000) + 1000;
  const backoff = Math.min(30000, 2000 * (2 ** Math.max(0, attempt - 1)));
  return backoff + Math.floor(Math.random() * 750);
}

function isRetryableMistralNetworkError(error) {
  const detail=String(error&&error.message||error||'');
  if(/parameter=timeoutMs|generation_cancelled/i.test(detail))return false;
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|connection reset|conex[aã]o/i.test(detail);
}
function isMistralKeyFallbackStatus(status){
  return [401,403,429].includes(Number(status));
}
function isMistralModelAvailabilityError(status,message){
  return [400,404,422].includes(Number(status))&&/(model|modelo).*(?:not found|unknown|invalid|unavailable|access|permission|does not exist|não existe|indisponível)/i.test(String(message||''));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const externalSignal=options&&options.signal;
  const requestOptions={...options,signal:controller.signal};
  const abortFromExternal=()=>controller.abort('external');
  if(externalSignal){
    if(externalSignal.aborted)controller.abort('external');
    else externalSignal.addEventListener('abort',abortFromExternal,{once:true});
  }
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, requestOptions);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if(externalSignal&&externalSignal.aborted){
        const cancelled=new Error('Falha de API: parameter=generation_cancelled; motivo=operação cancelada pelo usuário.');
        cancelled.code='GENERATION_CANCELLED';
        throw cancelled;
      }
      const timeoutError = new Error(`Falha de API: parameter=timeoutMs; value=${timeoutMs}; motivo=tempo limite de processamento excedido.`);
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if(externalSignal)externalSignal.removeEventListener('abort',abortFromExternal);
  }
}

async function fetchMistralWithRetry(url, options = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 1; attempt <= MISTRAL_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!MISTRAL_TRANSIENT_STATUSES.has(response.status) || attempt === MISTRAL_MAX_ATTEMPTS) {
        return { response, attempts: attempt };
      }
      await wait(mistralRetryDelay(attempt, response));
    } catch (error) {
      lastError = error;
      if (!isRetryableMistralNetworkError(error) || attempt === MISTRAL_MAX_ATTEMPTS) {
        error.mistralAttempts = attempt;
        throw error;
      }
      await wait(mistralRetryDelay(attempt));
    }
  }
  lastError.mistralAttempts = MISTRAL_MAX_ATTEMPTS;
  throw lastError;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-InkVortex-Studio-Version': STUDIO_VERSION
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function apiErrorDescriptor(error){
  const detail=sanitizeTelemetryMessage(error&&error.message?error.message:error);
  if(/generation_cancelled/i.test(detail))return {status:499,code:'cancelled',error:'A geração foi cancelada por você.',detail};
  if(/timeoutMs|tempo limite/i.test(detail))return {status:504,code:'timeout',error:'A API ultrapassou o tempo desta etapa. O conteúdo anterior foi preservado.',detail};
  if(/http=429|quota|rate.?limit|limite de requisi/i.test(detail))return {status:429,code:'quota',error:'A cota ou o limite temporário da API foi atingido. Aguarde o intervalo indicado pelo provedor e tente novamente.',detail};
  if(/key_slot|http=401|http=403|api key|chave/i.test(detail))return {status:401,code:'key',error:'A Mistral recusou as chaves configuradas. Verifique MISTRAL_API_KEY e MISTRAL_API_KEY_2 no arquivo .env.',detail};
  if(/model.*(?:not found|unknown|invalid|unavailable|access)|modelo.*(?:não existe|indisponível)/i.test(detail))return {status:422,code:'model',error:'O modelo configurado não está disponível nesta conta. O Studio tentou o alias da mesma família antes de interromper.',detail};
  if(/JSON inválido|JSON invalido|response_format|fora do formato JSON/i.test(detail))return {status:502,code:'json',error:'A API respondeu, mas o JSON chegou inválido ou incompleto. Nenhum conteúdo foi substituído.',detail};
  if(/devolveu \d+ de \d+/i.test(detail))return {status:502,code:'incomplete',error:detail,detail};
  if(/connection|conexão|fetch failed|network/i.test(detail))return {status:503,code:'connection',error:'A conexão com a API falhou depois das retentativas automáticas. Nenhum conteúdo foi substituído. Detalhe: ' + detail,detail};
  return {status:500,code:'api',error:'A etapa foi interrompida. Detalhe técnico: ' + detail,detail};
}
function sendApiError(res,error){
  const descriptor=apiErrorDescriptor(error);
  send(res,descriptor.status,{error:descriptor.error,code:descriptor.code,detail:descriptor.detail});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Corpo da requisicao muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON invalido.'));
      }
    });
    req.on('error', reject);
  });
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf'
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(ROOT, '.' + pathname.replace(/\//g, path.sep));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, 'Arquivo nao encontrado.', 'text/plain; charset=utf-8');
    return;
  }
  const staticHeaders = {
    'Content-Type': mime(file),
    'X-InkVortex-Studio-Version': STUDIO_VERSION
  };
  if (/\.(?:html|js|css|json|txt)$/i.test(file)) {
    staticHeaders['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    staticHeaders.Pragma = 'no-cache';
    staticHeaders.Expires = '0';
  } else {
    staticHeaders['Cache-Control'] = 'public, max-age=300';
  }
  res.writeHead(200, staticHeaders);
  fs.createReadStream(file).pipe(res);
}


function normalizeFontLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function listLocalFontFamilies() {
  const fontRoot = path.join(ROOT, 'fonts');
  if (!fs.existsSync(fontRoot)) return [];
  const formats = new Map([['.woff2','woff2'],['.woff','woff'],['.ttf','truetype'],['.otf','opentype']]);
  const records = [];
  const walk = (dir, relativeParts = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const nextParts = [...relativeParts, entry.name];
      if (entry.isDirectory()) { walk(full, nextParts); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!formats.has(ext)) continue;
      const relativeFile = nextParts.join('/');
      const familyFolder = relativeParts.length ? relativeParts[0] : 'Fontes avulsas';
      const familyLabel = normalizeFontLabel(familyFolder) || 'Fontes avulsas';
      const stem = path.basename(entry.name, ext);
      let variationLabel = normalizeFontLabel(stem);
      const familyPrefix = new RegExp('^' + familyLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
      variationLabel = variationLabel.replace(familyPrefix, '').trim() || 'Regular';
      if (relativeParts.length > 1) {
        const nested = relativeParts.slice(1).map(normalizeFontLabel).filter(Boolean).join(' / ');
        if (nested) variationLabel = nested + ' / ' + variationLabel;
      }
      const familyId = 'local-family-' + Buffer.from(familyFolder, 'utf8').toString('base64url');
      const id = 'local-font-' + Buffer.from(relativeFile, 'utf8').toString('base64url');
      const encodedUrl = '/fonts/' + nextParts.map(encodeURIComponent).join('/');
      records.push({
        id,
        label: variationLabel,
        familyId,
        familyLabel,
        file: relativeFile,
        fontFamily: 'InkVortexLocal_' + id.replace(/[^a-z0-9_]/gi, '_'),
        url: encodedUrl,
        format: formats.get(ext)
      });
    }
  };
  walk(fontRoot);
  const grouped = new Map();
  for (const font of records) {
    if (!grouped.has(font.familyId)) grouped.set(font.familyId, { id: font.familyId, label: font.familyLabel, source: 'local', variants: [] });
    grouped.get(font.familyId).variants.push(font);
  }
  return [...grouped.values()]
    .map(family => ({ ...family, variants: family.variants.sort((a,b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' })) }))
    .sort((a,b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' }));
}

function normalizeStageBackgroundLabel(value) {
  return String(value || '')
    .replace(/^\d{1,3}[\s._-]*/, '')
    .replace(/(?:[-_ ]?1920[-_ ]?x[-_ ]?1080)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function listStageBackgrounds() {
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
  const stageRoot = path.join(ROOT, 'palco');
  const records = [];
  const walk = (dir, relativeParts = []) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const nextParts = [...relativeParts, entry.name];
      if (entry.isDirectory()) { walk(full, nextParts); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowed.has(ext)) continue;
      const relativeFile = nextParts.join('/');
      const stem = path.basename(entry.name, ext);
      const orderMatch = stem.match(/^(\d{1,3})(?:\D|$)/);
      const stat = fs.statSync(full);
      records.push({
        id: 'stage-user-' + Buffer.from(relativeFile, 'utf8').toString('base64url'),
        label: normalizeStageBackgroundLabel(stem) || 'Palco sem nome',
        file: 'palco/' + relativeFile,
        url: '/palco/' + nextParts.map(encodeURIComponent).join('/'),
        order: orderMatch ? Number(orderMatch[1]) : null,
        native: false,
        source: 'user',
        modifiedAt: stat.mtimeMs
      });
    }
  };
  walk(stageRoot);
  return records.sort((a, b) => {
    const aHasNumber = Number.isFinite(a.order), bHasNumber = Number.isFinite(b.order);
    if (aHasNumber && bHasNumber && a.order !== b.order) return a.order - b.order;
    if (aHasNumber !== bHasNumber) return aHasNumber ? -1 : 1;
    return a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base', numeric: true });
  });
}

function listBrandGalleryImages() {
  const galleryRoot = path.join(ROOT, 'galeria');
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
  const records=[];
  const walk=(dir,relativeParts=[])=>{
    if(!fs.existsSync(dir))return;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.name.startsWith('.'))continue;
      const full=path.join(dir,entry.name),nextParts=[...relativeParts,entry.name];
      if(entry.isDirectory()){walk(full,nextParts);continue;}
      if(!entry.isFile())continue;
      const ext=path.extname(entry.name).toLowerCase();if(!allowed.has(ext))continue;
      const stat=fs.statSync(full),stem=path.basename(entry.name,ext),orderMatch=stem.match(/^(\d{1,3})(?:\D|$)/);
      const label=stem.replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
      records.push({
        src:'/galeria/'+nextParts.map(encodeURIComponent).join('/'),
        alt:label||'Imagem InkVortex',
        order:orderMatch?Number(orderMatch[1]):null,
        modifiedAt:stat.mtimeMs
      });
    }
  };
  walk(galleryRoot);
  return records.sort((a,b)=>{
    const aHasNumber=Number.isFinite(a.order),bHasNumber=Number.isFinite(b.order);
    if(aHasNumber&&bHasNumber&&a.order!==b.order)return a.order-b.order;
    if(aHasNumber!==bHasNumber)return aHasNumber?-1:1;
    return a.alt.localeCompare(b.alt,'pt-BR',{sensitivity:'base',numeric:true});
  });
}

function serveLogo(res){
  const localLogo=path.join(ROOT,'logo-inkvortex','logo-inkvortex.png');
  const fallbackLogo=path.join(DEFAULTS_ROOT,'logo-inkvortex','logo-inkvortex.png');
  const file=fs.existsSync(localLogo)?localLogo:fallbackLogo;
  if(!fs.existsSync(file)){send(res,404,'Logo nao encontrada.','text/plain; charset=utf-8');return;}
  res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache','Expires':'0'});
  fs.createReadStream(file).pipe(res);
}

const API_CONTRACTS = Object.freeze({
  system:`Você é o núcleo de inteligência editorial e direção criativa do InkVortex Studio, a central especialista da InkVortex Brasil em minisséries técnicas e educativas de alta autoridade. 

Sua atuação é pautada por precisão científica, elegância visual, fluidez narrativa e rigor conceitual. Em cada chamada, execute exclusivamente a etapa solicitada com foco em profundidade e clareza, entregando sua resposta estritamente no formato JSON especificado, em português do Brasil. 

Mantenha a prosa concisa, rica e envolvente, priorizando a essência de cada conceito com extrema sofisticação. Devolva apenas o código JSON limpo e válido, sem saudações, introduções ou explicações fora da estrutura solicitada.`,

  themes:`Atue como curador editorial sênior e estruture exatamente 3 (três) ideias editoriais inéditas e fascinantes para o assunto informado.

REGRAS DE DIVERSIFICAÇÃO EDITORIAL:
- Explore abordagens genuinamente distintas entre as 3 ideias, variando os mecanismos técnicos, as aplicações práticas, as causas-raiz e a evidência visual observável.
- Utilize a memória de novidade fornecida como guia para evitar duplicações, expandindo o tema com novos ângulos de autoridade.

ESPECIFICAÇÃO DE SAÍDA (JSON):
Retorne estritamente um objeto JSON limpo contendo a chave "topics" com o array das 3 ideias. Cada objeto deve conter exatamente as seguintes chaves:

{
  "topics": [
    {
      "title": "[Título magnético e altamente técnico da minissérie]",
      "angle": "[Ângulo central e perspectiva inédita de abordagem]",
      "centralQuestion": "[Pergunta instigante que a minissérie responde]",
      "editorialPromise": "[Promessa de transformação de conhecimento para o leitor]",
      "technicalTruth": "[Verdade técnica/científica que sustenta a tese]",
      "why": "[Justificativa editorial do motivo desta ideia ser relevante agora]",
      "visualDirection": "[Direção estética e elementos de cenário para a produção]"
    }
  ]
}`,

  scenes45:`Você é o Diretor de Arte e Redator Editorial de elite da InkVortex Brasil. Sua missão é criar a narrativa conceitual e visual de um carrossel educativo composto por exatamente 5 (cinco) cenas estáticas verticais (proporção 9:16).

DIRETRIZES ESTÉTICAS E NARRATIVAS:
- Crie composições cenográficas realistas e sofisticadas, utilizando materiais nobres (madeira escura, vidro soprado, metais acetinados, líquidos e tecidos estruturados) que tangibilizem o assunto.
- Integração de Marca (Obrigatória): Incorporar a marca "InkVortex Brasil" de forma orgânica, legível e fisicamente coerente a um objeto real do cenário (ex: gravada em metal, estampada em couro ou impressa no vidro).
- Estrutura Textual: Cada cena deve possuir uma manchete envolvente (máximo 13 palavras) e exatamente 3 frases informativas curtas.

ESPECIFICAÇÃO DE SAÍDA (JSON):
Retorne estritamente um objeto JSON válido contendo a chave "scenes45" com o array de exatamente 5 objetos:

{
  "scenes45": [
    {
      "number": 1,
      "title": "[Manchete editorial envolvente de até 13 palavras]",
      "lines": [
        "[Linha 1: Fato ou dado técnico preciso]",
        "[Linha 2: Curiosidade ou mecanismo surpreendente]",
        "[Linha 3: Aplicação prática e educativa]"
      ],
      "prompt": "[Prompt fotográfico realista 9:16 detalhando cenário, iluminação, texturas e a marca InkVortex Brasil integrada a um objeto]"
    }
  ]
}`,

  scenes916:`Você é o Diretor de Fotografia da InkVortex Brasil especialista em imagens de alta velocidade e dinamismo visual. Sua missão é criar 5 (cinco) prompts de imagem vertical (proporção 9:16) que capturem momentos de ação, dinamismo e física viva, criando uma forte sensação de movimento em cada composição.

DIRETRIZES VISUAIS DE MOVIMENTO IMPLÍCITO:
- Dinâmica Congelada: Descreva cenas em um instante de ação física intensa — como a tensão superficial de um fluido prestes a se romper, partículas em suspensão, tecidos capturados em plena dobra pelo ar ou luz refletindo em matéria em transformação.
- Narrativa Visual: Cada imagem deve sugerir uma história em curso, onde o leitor percebe o que aconteceu um segundo antes e o que acontecerá um segundo depois.
- Integração de Marca (Obrigatória): O texto "InkVortex Brasil" deve estar fisicamente integrado a um objeto real da cena (ex: gravado na peça, impresso no tecido, gravado no vidro) de forma estável, legível e natural.

ESPECIFICAÇÃO DE SAÍDA (JSON):
Retorne estritamente um objeto JSON válido contendo a chave "motionScenes" com o array das 5 cenas de dinamismo visual:

{
  "motionScenes": [
    {
      "number": 1,
      "motionPrompt": "[Prompt de imagem vertical 9:16 capturando um momento dinâmico e vivo de ação física, com riqueza de texturas e a marca InkVortex Brasil fisicamente integrada a um objeto]"
    }
  ]
}`,

  flowMaster:`Você é o Diretor de Cinema Generativo da InkVortex Brasil. Sua missão é consolidar as 5 cenas visuais em um Roteiro Master cinemático sintético no formato vertical 9:16 para um vídeo de exatamente 10 segundos.

DIRETRIZES:
- Introdução: Escreva uma frase curta resumindo o estilo visual e paleta de cores.
- Cenas (Cena 1 a 5): Para CADA cena, escreva exatamente uma frase curta focada apenas no movimento de câmera principal e no objeto protagonista.
- Transições: Escreva exatamente uma frase curta descrevendo a transição suave para a próxima cena.

ESPECIFICAÇÃO DE SAÍDA (JSON):
Retorne estritamente um objeto JSON válido contendo a chave "introduction" e a chave "scenes" com a lista exata das 5 cenas:

{
  "introduction": "[frase curta resumindo o estilo visual 9:16 e atmosfera]",
  "scenes": [
    {
      "number": 1,
      "description": "[frase curta focada no movimento de câmera e objeto principal]",
      "transition": "[frase curta descrevendo a transição suave para a próxima cena]"
    }
  ]
}`,

  caption:`Você é o Redator Editorial e Especialista em Conteúdo Social da InkVortex Brasil. Sua missão é escrever uma legenda narrativa envolvente, educativa e de alta autoridade para o Instagram/LinkedIn, baseada no conhecimento técnico das cenas da minissérie.

REGRAS DE ESTRUTURAÇÃO DA LEGENDA:
1. Estrutura Narrativa com Início, Meio e Fim: Desenvolva um texto educativo com progressão lógica. Não repita os títulos do carrossel (que o leitor já viu nas imagens); em vez disso, aprofunde a explicação dos porquês, mecanismos e consequências materiais.
2. Início, Meio e Fim:
   - Início (Linhas 1-2): Introdução atraente da tese e dor/descoberta técnica.
   - Meio (Linhas 3-8): Aprofundamento dos processos, causa e efeito e transformações físicas.
   - Fim (Linhas 9-10): Síntese de aprendizado prático e conclusão de autoridade.
3. Organização em 10 Linhas Escaneáveis: Escreva exatamente 10 (dez) frases/parágrafos educativos. Inicie CADA UMA das 10 frases em uma NOVA LINHA acompanhada de 1 (um) emoji pertinente.
4. Sem Marcadores: Não utilize números (ex: 1., 2.), nem subtítulos ou marcadores de lista.
5. Conteúdo Puramente Educativo: Não inclua chamadas comerciais, links de bio ou ofertas de produtos.
6. Bloco de Hashtags: Ao final das 10 frases, inclua o bloco de hashtags estratégicas do setor, finalizado com #InkVortexBrasil.

ESPECIFICAÇÃO DE SAÍDA (JSON):
Retorne estritamente um objeto JSON limpo contendo a chave "socialCaption":

{
  "socialCaption": "[10 frases educativas com início, meio e fim em novas linhas com emoji inicial, seguidas do bloco de hashtags com #InkVortexBrasil no final]"
}`,

  audio:`Você é o Diretor Musical e Produtor de Trilha Sonora da InkVortex Brasil. Sua missão é conceber um Roteiro Sonoro e Lírico refinado para um vídeo de exatamente 60 (sessenta) segundos, estruturado em 3 (três) Atos rítmicos.

DIRETRIZES MUSICAIS E CONTRATUAIS:
1. Idioma Obrigatório (pt-BR): Toda a letra, vocalização e locução DEVEM ser compostas estritamente em Português do Brasil (pt-BR), com sotaque e fonética brasileira.
2. Identidade da Marca (Obrigatória e Fonética Separada): A marca DEVE ser redigida obrigatoriamente como "Inki Vortéx" ou "Inki Vortéx Brasil" no Roteiro Vocal (Ato 3) para garantir que o motor de síntese vocal e cantada da IA leia e cante com dicção, articulação e clareza perfeita: 'Inki' ... 'Vortéx Brasil'.
3. Estrutura Rítmica dos 3 Atos (60 Segundos):
   - Ato 1 - A Preparação (0s - 11s): Atmosfera inicial, acordes de abertura e instrumentos orgânicos/sintéticos.
   - Ato 2 - O Desenvolvimento (11s - 46s): Progressão rítmica, entrada da percussão e narrativa técnica sobre a minissérie.
   - Ato 3 - O Ápice e Merchã Inki Vortéx (46s - 60s): Clímax musical com menção expressiva da marca Inki Vortéx Brasil e encerramento memorável.
4. Fluidez: Escreva o texto de cada Ato como um parágrafo contínuo, sem fatiamentos secundários.

ESPECIFICAÇÃO DE SAÍDA (JSON):
Retorne estritamente um objeto JSON válido contendo a chave "acts" com a lista dos 3 Atos:

{
  "acts": [
    {
      "act": 1,
      "name": "A Preparação",
      "duration": "0s - 11s",
      "description": "[Parágrafo contínuo descrevendo a harmonia e arranjo inicial (0s a 11s)]"
    },
    {
      "act": 2,
      "name": "O Desenvolvimento",
      "duration": "11s - 46s",
      "description": "[Parágrafo contínuo descrevendo o ritmo e desenvolvimento da narrativa (11s a 46s)]"
    },
    {
      "act": 3,
      "name": "O Ápice e Merchã Inki Vortéx",
      "duration": "46s - 60s",
      "description": "[Parágrafo contínuo descrevendo o clímax, a menção da marca Inki Vortéx Brasil e desfecho elegante (46s a 60s)]"
    }
  ]
}`
});

function auditApiContracts(){
  const tasks=['themes','scenes45','scenes916','caption','audio','flowMaster'];
  const issues=[];
  if(!API_CONTRACTS.system)issues.push('contrato base ausente');
  tasks.forEach(task=>{if(!API_CONTRACTS[task])issues.push(`contrato ausente: ${task}`);if(!STAGE_PROFILES[task])issues.push(`perfil ausente: ${task}`)});
  if(!/carrossel educativo/i.test(API_CONTRACTS.scenes45))issues.push('GPT não está ancorado em carrossel educativo');
  if(!/Manchete/i.test(API_CONTRACTS.scenes45))issues.push('GPT não instrui títulos como manchetes');
  if(!/motionPrompt/i.test(API_CONTRACTS.scenes916))issues.push('Gemini não contém motionPrompt');
  return {ok:issues.length===0,source:'API_CONTRACTS',studioVersion:STUDIO_VERSION,engineVersion:ENGINE_VERSION,tasks,issues};
}

const API_CONTRACT_AUDIT = auditApiContracts();
if (!API_CONTRACT_AUDIT.ok) console.warn(`Auditoria de contratos: ${API_CONTRACT_AUDIT.issues.join('; ')}`);

function sourceTopicFromPayload(payload) {
  const topic=payload&&payload.topic&&typeof payload.topic==='object'?payload.topic:{};
  return {
    id:String(topic.id||'').trim(), title:String(topic.title||'').trim(), angle:String(topic.angle||'').trim(), why:String(topic.why||'').trim(),
    visualDirection:String(topic.visualDirection||'').trim(), centralQuestion:String(topic.centralQuestion||'').trim(),
    editorialPromise:String(topic.editorialPromise||'').trim(), technicalTruth:String(topic.technicalTruth||'').trim(),
    avoidCliches:Array.isArray(topic.avoidCliches)?topic.avoidCliches.slice(0,12).map(value=>String(value||'').trim()).filter(Boolean):[],
    groupId:String(topic.groupId||'').trim(), groupSubject:String(topic.groupSubject||'').trim()
  };
}
function stableSerialize(value) {
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function generationIntentFromPayload(payload) {
  return String(payload&&payload.generationIntent||'new-from-idea').trim()||'new-from-idea';
}
function compactIdeaField(value,limit=120){
  const text=String(value||'').replace(/\s+/g,' ').trim();
  return text.length>limit?text.slice(0,limit-1).trimEnd()+'…':text;
}
function compactIdeaSignature(item) {
  return {
    t:compactIdeaField(item&&item.title,110),
    q:compactIdeaField(item&&item.centralQuestion,130),
    m:compactIdeaField(item&&item.technicalTruth||item&&item.angle,130),
    v:compactIdeaField(item&&item.visualDirection,130)
  };
}
function representativeIdeaSignatures(items,limit=30){
  const raw=(Array.isArray(items)?items:[]).map(compactIdeaSignature).filter(item=>item.t||item.q||item.m||item.v);
  const deduped=[];const seen=new Set();
  for(const item of raw){
    const key=JSON.stringify(item).toLocaleLowerCase('pt-BR');
    if(seen.has(key))continue;
    seen.add(key);deduped.push(item);
  }
  if(deduped.length<=limit)return deduped;
  const recentCount=Math.min(18,limit),olderSlots=limit-recentCount;
  const recent=deduped.slice(-recentCount),older=deduped.slice(0,-recentCount),sampled=[];
  if(olderSlots>0&&older.length){
    for(let i=0;i<olderSlots;i++){
      const index=Math.min(older.length-1,Math.floor(i*older.length/olderSlots));
      sampled.push(older[index]);
    }
  }
  return [...sampled,...recent];
}
function buildThemeContext(payload){
  const brief=String(payload&&payload.brief||'').trim();
  const allExisting=Array.isArray(payload&&payload.existingIdeas)?payload.existingIdeas:[];
  const memory=representativeIdeaSignatures(allExisting,24);
  return `ASSUNTO
${brief}

MEMÓRIA DE NOVIDADE (${memory.length} referências representativas de ${allExisting.length} ideias armazenadas)
${JSON.stringify(memory)}

Crie três ideias novas que ampliem o mapa editorial. Diferencie o núcleo de cada proposta e preserve liberdade para abordar o mesmo assunto por mecanismos, aplicações e evidências visuais realmente distintos. Lembre-se: O retorno DEVE ser um Objeto JSON contendo exatamente a chave "topics" com o Array das 3 ideias, sem nenhum texto extra.`;
}
function stripEmojisAndHashtags(text) {
  if (!text) return '';
  let str = String(text);
  // Remove hashtags
  str = str.replace(/#\S+/g, '');
  // Remove emojis and pictographs
  try {
    str = str.replace(/\p{Extended_Pictographic}/gu, '');
  } catch(e) {}
  str = str.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  
  return str.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function buildAudioContext(payload) {
  let rawCaption = payload.caption || '';
  if (!rawCaption || rawCaption === 'Sem legenda.') {
    if (payload.scenes && Array.isArray(payload.scenes) && payload.scenes.length > 0) {
      rawCaption = payload.scenes.map((s, i) => `Cena ${i+1}: ${s.title || ''} - ${Array.isArray(s.lines) ? s.lines.join(' ') : (s.prompt || '')}`).join('\n');
    } else if (payload.topic) {
      rawCaption = typeof payload.topic === 'string' ? payload.topic : (payload.topic.title || payload.topic.description || '');
    }
  }

  const cleanCaption = stripEmojisAndHashtags(rawCaption) || payload.campaignTitle || 'Contexto Educativo InkVortex';

  return `[ CONTRATO DE PRODUÇÃO MUSICAL 60s - INKVORTEX BRASIL ]
Idioma Vocal: Português do Brasil (pt-BR - Fonética Brasileira)
Tema da Obra: "${payload.campaignTitle || 'Tema Livre'}"
Estilo & Arranjo: "${payload.style || 'Cinematic & Immersive'}"
Marca Assinatura: InkVortex Brasil
Duração Total: 60 Segundos (Ato 1: 0s-11s | Ato 2: 11s-46s | Ato 3: 46s-60s)

Contexto Narrativo:
"${cleanCaption}"
[ FIM DO CONTRATO ]`;
}
function compactRegenerationReference(payload){
  const current=payload&&payload.currentCampaign&&typeof payload.currentCampaign==='object'?payload.currentCampaign:null;
  if(!current)return null;
  return {
    title:compactIdeaField(current.title,180),
    scenes:(Array.isArray(current.scenes)?current.scenes:[]).slice(0,5).map((scene,index)=>({
      number:index+1,
      title:compactIdeaField(scene&&scene.title,220),
      lines:Array.isArray(scene&&scene.lines)?scene.lines.slice(0,3).map(value=>compactIdeaField(value,220)):[],
      visualCore:compactIdeaField(scene&&scene.prompt,1600)
    })),
    motionScenes:(Array.isArray(current.motionScenes)?current.motionScenes:[]).slice(0,5).map((scene,index)=>({
      number:index+1,
      motionPrompt:compactIdeaField(scene&&scene.motionPrompt,1300)
    })),
    socialCaption:compactIdeaField(current.socialCaption,1800)
  };
}
function buildScenes45Context(payload){
  const topic=sourceTopicFromPayload(payload||{});
  const regenerationReference=compactRegenerationReference(payload);
  const context={
    subject:String(payload&&payload.brief||topic.groupSubject||'').trim(),
    selectedIdea:{
      title:topic.title,
      angle:topic.angle,
      centralQuestion:topic.centralQuestion,
      visualDirection:topic.visualDirection,
      technicalTruth:topic.technicalTruth,
      avoidCliches:topic.avoidCliches
    },
    finalUse:'Cinco imagens verticais para carrossel educativo e para a seção central de um vídeo de 50 segundos. O Studio acrescenta localmente o título editorial e a identidade tipográfica.',
    editorialIntent:'Cada cena deve educar e informar o público sobre o assunto. O título (title) é uma manchete informativa com contexto para funcionar como capa. As 3 linhas de apoio (lines) são estrofes educativas que explicam aspectos do tema ao leitor.'
  };
  if(regenerationReference)context.currentMiniseries=regenerationReference;
  const direction=regenerationReference
    ? 'Faça uma nova execução completa da mesma minissérie, preservando sua pergunta central, mas renovando títulos, evidências e soluções visuais.'
    : 'Distribua o assunto em cinco recortes editoriais complementares.';
    
  let fileText = '';
  try {
     fileText = fs.readFileSync(path.join(__dirname, '..', 'gpt', 'abertura.txt'), 'utf8');
  } catch(e) {
     fileText = `MINISSÉRIE GPT IMAGE, CARROSSEL EDUCATIVO — CINCO COMPOSIÇÕES ESTÁTICAS 9:16\n${direction} O objetivo de cada cena é ilustrar e explicar visualmente um aspecto real do assunto...`;
  }
  
  return `${fileText}\n\n[DADOS DA MINISSÉRIE]\n${JSON.stringify(context,null,2)}\n`;
}
function buildScenes916Context(payload,scenes45){
  const topic=sourceTopicFromPayload(payload||{});
  const miniseries=(Array.isArray(scenes45)?scenes45:[]).map((scene,index)=>({
    number:index+1,
    title:compactIdeaField(scene&&scene.title,220),
    lines:Array.isArray(scene&&scene.lines)?scene.lines.slice(0,3).map(value=>compactIdeaField(value,220)):[],
    visualCore:compactIdeaField(scene&&scene.prompt,1600)
  }));
  const context={
    selectedIdea:{title:topic.title,centralQuestion:topic.centralQuestion,visualDirection:topic.visualDirection},
    purpose:'Cada texto descreve como a cena educativa original do GPT ganha vida e se movimenta, para ser colado no gerador de vídeo do Gemini. O Flow é uma etapa separada e não deve ser mencionado.',
    staticReferencesGPT:miniseries
  };
  
  let fileText = '';
  try {
     fileText = fs.readFileSync(path.join(__dirname, '..', 'gemini', 'abertura.txt'), 'utf8');
  } catch(e) {
     fileText = `MINISSÉRIE GEMINI, CINCO CENAS EM MOVIMENTO 9:16\nPara cada referência GPT, escreva um motionPrompt autossuficiente. O objetivo não é descrever um frame estático, mas dar vida...`;
  }
  
  return `${fileText}\n\n[DADOS DA MINISSÉRIE]\n${JSON.stringify(context,null,2)}\n`;
}
function buildCaptionContext(payload){
  const campaign=payload&&payload.campaign?payload.campaign:{};
  const topic=campaign&&campaign.topic&&typeof campaign.topic==='object'?campaign.topic:{};
  const scenes=(Array.isArray(campaign.scenes)?campaign.scenes:[]).map((scene,index)=>({
    number:index+1,
    title:compactIdeaField(scene&&scene.title,240),
    lines:Array.isArray(scene&&scene.lines)?scene.lines.slice(0,3).map(value=>compactIdeaField(value,320)):[],
    visualEvidence:compactIdeaField(scene&&scene.prompt,1500)
  }));
  const context={
    campaignTitle:compactIdeaField(campaign.title,240),
    selectedIdea:{
      title:compactIdeaField(topic.title,240),
      angle:compactIdeaField(topic.angle,320),
      centralQuestion:compactIdeaField(topic.centralQuestion,420),
      visualDirection:compactIdeaField(topic.visualDirection,520)
    },
    purpose:'Legenda narrativa de aprofundamento e aprendizado para redes sociais com início, meio e fim, baseada no contexto das cenas do GPT.',
    scenes
  };
  return `LEGENDA SOCIAL DE ALTA AUTORIDADE E APRENDIZADO DA MINISSÉRIE
${JSON.stringify(context,null,2)}

Escreva uma legenda social educativa completa e elaborada sobre a minissérie, estruturada com Início, Meio e Fim. Use todo o conhecimento técnico das cenas do GPT como base para aprofundar o assunto e explicar os porquês, sem repetir simplesmente os títulos do carrossel. O texto deve ser altamente educativo, agregando valor real de aprendizado para o leitor.
A legenda deve vir estruturada em exatamente 10 frases curtas e consecutivas. Para garantir uma leitura escaneável no Instagram/LinkedIn, inicie CADA UMA das 10 frases em uma NOVA LINHA (novo parágrafo) acompanhada de 1 emoji inicial contextualizado. Não use subtítulos nem marcadores numéricos. Ao final do texto, inclua um bloco com hashtags relevantes terminando em #InkVortexBrasil. Não adicione chamadas comerciais ou links.`;
}


function removeTextInstructions(prompt) {
  let text = String(prompt || '').trim();
  for (const marker of ['TEXT LOCK - CRITICAL:', 'Main title: create a very large', 'Main title: extra-large', 'TITLE EXACT:', 'SUPPORT LINE 1 EXACT:', 'TITULO EXATO:', 'LINHA DE APOIO 1 EXATA:', 'Titulo principal:', 'Título principal:']) {
    const index = text.indexOf(marker);
    if (index !== -1) text = text.slice(0, index).trim();
  }
  const blocked = /\b(main\s*title|support\s*lines?|supporting\s+lines?|title\s*exact|subtitle|subtitles|headline|caption|typography|font|fredoka|overlay|embedded\s+text|text\s+overlay|render\s+the\s+text|rendered\s+text|text\s+elements|legibility|kerning|line\s+height|exact\s+text|portuguese\s+text|texts?|words?|wording|written|writing|lettering|letters?|copy|texto|textos?|palavras?|escrita|escrito|titulo|t[ií]tulo|subt[ií]tulo|legenda|tipografia|fonte)\b/i;
  const sentences = text
    .replace(/([.!?])\s+/g, '$1\n')
    .split(/\n+/)
    .map(part => part.trim())
    .filter(Boolean);
  const visualSentences = sentences.filter(sentence => !blocked.test(sentence));
  return (visualSentences.length ? visualSentences.join(' ') : text).trim();
}

function sceneContentOnly(prompt){
  let text=String(prompt||'').trim();
  const patterns=[
    /^fotografia\s+editorial\s+est[aá]tica(?:\s+profissional)?(?:\s+vertical)?(?:\s+em\s+formato)?\s*4\s*[:x]\s*5(?:\s*,?\s*em\s+tela\s+cheia)?[\s.,:;-]*/i,
    /^fotografia\s+editorial\s+est[aá]tica(?:\s+profissional)?[\s.,:;-]*/i,
    /^fotografia\s+est[aá]tica(?:\s+profissional)?(?:\s+vertical)?(?:\s+em\s+formato)?\s*4\s*[:x]\s*5[\s.,:;-]*/i,
    /^fotografia\s+est[aá]tica(?:\s+profissional)?[\s.,:;-]*/i,
    /^vertical\s+4\s*[:x]\s*5\s+em\s+tela\s+cheia;?\s*(?:fotografia\s+est[aá]tica\s+profissional)?[\s.,:;-]*/i,
    /^vertical\s+4\s*[:x]\s*5(?:\s+em\s+tela\s+cheia|\s+full[-\s]?bleed)?[\s.,:;-]*/i,
    /^imagem\s+em\s+movimento(?:\s+vertical)?(?:\s+em\s+formato)?\s*9\s*[:x]\s*16[\s.,:;-]*/i,
    /^imagem\s+vertical\s*9\s*[:x]\s*16(?:\s+em\s+movimento)?[\s.,:;-]*/i,
    /^crie\s+uma\s+imagem\s+em\s+formato\s+vertical\s*9\s*[:x]\s*16[\s.,:;-]*/i,
    /^(?:a\s+)?vertical\s+9\s*[:x]\s*16\s*full[-\s]?bleed\s*(?:static\s*)?(?:professional\s+photograph|photo|photograph|image)?[\s.,:;-]*/i,
    /^(?:a\s+)?vertical\s+9\s*[:x]\s*16(?:\s+full[-\s]?bleed)?(?:\s+static)?(?:\s+photo|\s+image)?[\s.,:;-]*/i,
    /^(?:a\s+)?portrait\s+9\s*[:x]\s*16\s*(?:format|orientation)?[\s.,:;-]*/i
  ];
  let changed;
  do{
    changed=false;
    for(const pattern of patterns){
      const cleaned=text.replace(pattern,'').trim();
      if(cleaned!==text){text=cleaned;changed=true;}
    }
  }while(changed);
  text=removeExtraFormatNoise(text);
  return text.replace(/^(?:[.,;:\-]\s*)+/,'').trim();
}
function removeExtraFormatNoise(text) {
  text = String(text || '');
  text = text.replace(/^fotografia\s+estatica\s+profissional\s+(?:de\s+)?/i, '');
  text = text.replace(/^fotografia\s+estatica\b[\s.,:;-]*/i, '');
  text = text.replace(/^static\s+(?:professional\s+photograph|photo|photograph|image|shot|composition)\s+of\s+/i, '');
  text = text.replace(/^static\s+(?:professional\s+photograph|photo|photograph|image|shot|composition)\b[\s.,:;-]*/i, '');
  text = text.replace(/^static\b[\s.,:;-]*/i, '');
  text = text.replace(/\bstatic\s+(photo|image|shot|composition)\b/gi, '$1');
  text = text.replace(/,\s*(?:vertical\s+9\s*[:x]\s*16|9\s*[:x]\s*16\s*vertical|portrait\s+9\s*[:x]\s*16)\s*(?:full[-\s]?(?:bleed|screen|frame))?\s*(?:static\s*)?(shot|photo|image|composition)\b/gi, ' $1');
  text = text.replace(/\b(?:vertical\s+9\s*[:x]\s*16|9\s*[:x]\s*16\s*vertical|portrait\s+9\s*[:x]\s*16)\s*(?:full[-\s]?(?:bleed|screen|frame))?\s*(?:static\s*)?(?:shot|photo|image|composition|format|orientation)?[\s.,:;-]*/gi, '');
  text = text.replace(/\b(?:vertical\s+4\s*[:x]\s*5|4\s*[:x]\s*5\s*vertical)\s*(?:em\s+tela\s+cheia|full[-\s]?(?:bleed|screen|frame))?\s*(?:fotografia\s+estatica|imagem|foto|composicao)?[\s.,:;-]*/gi, '');
  text = text.replace(/\bfull[-\s]?(?:bleed|screen|frame)\s*(?:static\s*)?(shot|photo|image|composition)\b/gi, '$1');
  text = text.replace(/\b(macro|cinematic|close-up|wide|medium|overhead|top-down|low-angle|high-angle|documentary|editorial),\s+(shot|photo|image)\b/gi, '$1 $2');
  text = text.replace(/\s+,/g, ',').replace(/,\s*,/g, ', ').replace(/\s{2,}/g, ' ').trim();
  text = text.replace(/^[a-z]/, c => c.toUpperCase());
  return text;
}
function promptBaseOnly(prompt) {
  return sceneContentOnly(removeTextInstructions(prompt));
}
function exactTextFromPrompt(prompt, label) {
  const escaped = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(prompt || '').match(new RegExp('^' + escaped + ':\\s*"(.*)"\\s*$', 'm'));
  if (match) return match[1].trim();
  if (label === 'TITLE EXACT') {
    const ptMatch = String(prompt || '').match(/^TITULO EXATO:\s*"(.*)"\s*$/m);
    if (ptMatch) return ptMatch[1].trim();
  }
  const supportMatch = String(label || '').match(/^SUPPORT LINE\s+(\d+)\s+EXACT$/i);
  if (supportMatch) {
    const ptSupport = String(prompt || '').match(new RegExp('^LINHA DE APOIO ' + supportMatch[1] + ' EXATA:\\s*"(.*)"\\s*$', 'm'));
    if (ptSupport) return ptSupport[1].trim();
  }
  if (label === 'TITLE EXACT') {
    const legacy = String(prompt || '').match(/\b(?:main\s+)?title\s+(['"])(.*?)\1\s+(?:is|appears)\b/i);
    if (legacy) return legacy[2].trim();
  }
  return '';
}
function sceneTitleWithQuestionMark(title, sceneNo) {
  let text = String(title || '').trim();
  if (Number(sceneNo) === 1 && text && !/[?？]\s*$/.test(text)) {
    text = text.replace(/[.!。！]+\s*$/, '').trim() + '?';
  }
  return text;
}
function lockSceneText(scene) {
  let title = exactTextFromPrompt(scene && scene.prompt, 'TITLE EXACT') || String(scene && scene.title ? scene.title : '').trim();
  title = sceneTitleWithQuestionMark(title, scene && scene.number);
  const lines = Array.isArray(scene && scene.lines) ? scene.lines.map(x => String(x || '').trim()).filter(Boolean).slice(0, 3) : [];
  for (let i = 0; i < 3; i++) {
    const exact = exactTextFromPrompt(scene && scene.prompt, `SUPPORT LINE ${i + 1} EXACT`);
    if (exact) lines[i] = exact;
  }
  while (lines.length < 3) lines.push('');
  scene.prompt = promptBaseOnly(scene && scene.prompt ? scene.prompt : '');
  scene.title = title;
  scene.lines = lines;
  return scene;
}
const STATIC_BRAND_INTEGRATION='A marca "InkVortex Brasil" aparece integrada fisicamente e com discrição em um único elemento real da cena, como etiqueta, gravação, placa, painel, embalagem, ferramenta ou carcaça, sempre subordinada ao assunto principal.';
const MOTION_BRAND_PRESERVATION='A marca "InkVortex Brasil" permanece estável, legível e fisicamente integrada ao mesmo elemento real durante todo o clipe, sem deformação ou texto mutante.';
function ensureBrandPresence(value,mode='static'){
  return String(value||'').replace(/\s+/g,' ').trim();
}
function firstUsefulText(...values){
  for(const value of values){
    if(Array.isArray(value)){
      const joined=value.map(item=>String(item||'').trim()).filter(Boolean).join(' ');
      if(joined)return joined;
      continue;
    }
    const text=String(value||'').replace(/\s+/g,' ').trim();
    if(text)return text;
  }
  return '';
}
function normalizeScenes45(result){
  const source=Array.isArray(result&&result.scenes45)?result.scenes45:[];
  const raw=source.filter(scene=>scene&&typeof scene==='object'&&firstUsefulText(scene.title,scene.prompt,scene.lines));
  if(!raw.length)throw new Error('A API não devolveu nenhuma cena GPT legível.');
  return {title:firstUsefulText(result&&result.title,raw[0]&&raw[0].title,'Minissérie editorial'),scenes:raw.map((scene,index)=>{
    const copy={...scene,number:Number(scene.number)||index+1};
    copy.title=firstUsefulText(copy.title,Array.isArray(copy.lines)?copy.lines[0]:'',String(copy.prompt||'').split(/[.!?]/)[0],`Cena ${index+1}`);
    copy.lines=Array.isArray(copy.lines)?copy.lines.map(value=>String(value||'').trim()).filter(Boolean):[];
    copy.prompt=ensureBrandPresence(promptBaseOnly(firstUsefulText(copy.prompt,copy.title)),'static');
    return lockSceneText(copy);
  })};
}
function normalizeScenes916(result){
  const source=Array.isArray(result&&result.motionScenes)?result.motionScenes:[];
  const raw=source.filter(scene=>scene&&typeof scene==='object'&&firstUsefulText(scene.motionPrompt,scene.prompt,scene.text));
  if(!raw.length)throw new Error('A API não devolveu nenhum prompt Gemini legível.');
  return {motionScenes:raw.map((scene,index)=>({number:Number(scene.number)||index+1,motionPrompt:ensureBrandPresence(sceneContentOnly(firstUsefulText(scene.motionPrompt,scene.prompt,scene.text)).replace(/\s+/g,' ').trim(),'motion')}))};
}
function captionJsonToText(result){
  if(typeof result==='string'&&result.trim())return result.trim();
  const direct=String(result&&result.caption||result&&result.socialCaption||'').trim();
  const lines=Array.isArray(result&&result.lines)?result.lines.map(value=>String(value||'').trim()).filter(Boolean):[];
  const tags=Array.isArray(result&&result.hashtags)?result.hashtags.map(value=>String(value||'').trim()).filter(Boolean):[];
  let body=direct||lines.join('\n');
  if(tags.length&&!tags.some(tag=>/^#InkVortexBrasil$/i.test(tag)))tags.unshift('#InkVortexBrasil');
  // Remove hashtags que a API possa ter incluído dentro do body para evitar duplicação
  if(tags.length){
    body=body.split(/\r?\n/).map(line=>line.replace(/[\u200B-\u200D\uFEFF]/g,'').trim()).filter(line=>line&&!/^\s*#/u.test(line)).join('\n');
    // Também separa hashtags grudadas no final de frases
    body=body.split(/\r?\n/).map(line=>{let m=line.match(/^(.+?)\s+((?:#[\p{L}\p{N}_]+\s*){2,})$/u);return m?m[1].trim():line;}).join('\n');
  }
  const text=[body,tags.join(' ')].filter(Boolean).join('\n\n').trim();
  if(!text)throw new Error('A API não devolveu conteúdo Social legível.');
  return text;
}
function normalizeThemesForSave(result){
  const raw = Array.isArray(result && result.topics) ? result.topics : (Array.isArray(result) ? result : []);
  const usable=raw.filter(topic=>topic&&typeof topic==='object'&&firstUsefulText(topic.title,topic.angle,topic.centralQuestion,topic.editorialPromise,topic.technicalTruth,topic.why,topic.visualDirection));
  if(!usable.length)throw new Error('A API não devolveu nenhuma ideia legível.');
  const normalized=usable.map((topic,index)=>({
    id:firstUsefulText(topic.id,`idea-${Date.now().toString(36)}-${index+1}`),
    title:firstUsefulText(topic.title,topic.centralQuestion,topic.angle,`Ideia ${index+1}`),
    angle:firstUsefulText(topic.angle),
    centralQuestion:firstUsefulText(topic.centralQuestion),
    editorialPromise:firstUsefulText(topic.editorialPromise),
    technicalTruth:firstUsefulText(topic.technicalTruth),
    why:firstUsefulText(topic.why),
    visualDirection:firstUsefulText(topic.visualDirection)
  }));
  return {topics:normalized,receivedCount:normalized.length};
}

function extractJson(text) {
  const clean = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {}

  for (let start = 0; start < clean.length; start++) {
    if (clean[start] !== '{' && clean[start] !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < clean.length; index++) {
      const char = clean[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (!stack.length || stack.pop() !== char) break;
        if (!stack.length) {
          try {
            return JSON.parse(clean.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('A API respondeu fora do formato JSON.');
}
function extractMistralText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    if (part && typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n');
}
function extractInteractionText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (typeof data?.outputText === 'string') return data.outputText;
  const texts = [];
  (Array.isArray(data?.steps) ? data.steps : []).forEach(step => {
    if (step && step.type === 'model_output' && Array.isArray(step.content)) {
      step.content.forEach(part => {
        if (part && part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      });
    }
  });
  return texts.join('\n');
}

function sanitizeTelemetryMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function extractUsageMetadata(data) {
  const candidates = [
    data?.usageMetadata,
    data?.usage_metadata,
    data?.usage,
    data?.metadata?.usage,
    data?.response?.usageMetadata,
    data?.response?.usage_metadata
  ];
  const usage = candidates.find(item => item && typeof item === 'object' && Object.keys(item).length);
  return usage || null;
}

function writeApiTelemetry(event) {
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  };
  try {
    fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch {}
}

function apiTelemetrySummary(limit=500){
  if(!fs.existsSync(TELEMETRY_PATH))return {records:0,groups:[],latest:null};
  const lines=fs.readFileSync(TELEMETRY_PATH,'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.max(1,limit));
  const records=[];
  for(const line of lines){try{records.push(JSON.parse(line));}catch{}}
  const groups=new Map();
  for(const item of records){
    const key=[item.provider||'?',item.model||'?',item.modelStage||item.stageProfile||item.taskName||'?'].join('|');
    if(!groups.has(key))groups.set(key,{provider:item.provider||'',model:item.model||'',stage:item.modelStage||item.stageProfile||item.taskName||'',calls:0,successes:0,failures:0,totalDurationMs:0,lastError:''});
    const group=groups.get(key);group.calls+=1;group.successes+=item.ok?1:0;group.failures+=item.ok?0:1;group.totalDurationMs+=Number(item.durationMs)||0;if(!item.ok&&item.error)group.lastError=String(item.error).slice(0,220);
  }
  return {records:records.length,groups:[...groups.values()].map(group=>({...group,averageDurationMs:group.calls?Math.round(group.totalDurationMs/group.calls):0})),latest:records.at(-1)||null};
}

function activeProvider() {
  const provider = String(env('AI_PROVIDER', 'gemini')).trim().toLowerCase();
  if (provider === 'mistral') return 'mistral';
  return 'gemini';
}
let currentMistralKey = '';

function mistralApiKeys(){
  const values=[currentMistralKey, env('MISTRAL_API_KEY','')].map(value=>String(value||'').trim()).filter(Boolean);
  return [...new Set(values)];
}
function mistralModelCategory(stage) {
  if(stage==='themes')return 'FAST';
  if(['scenes45','scenes916','caption'].includes(stage))return 'CREATIVE';
  return 'DEFAULT';
}
function mistralModelForStage(taskName='') {
  const stage=canonicalStageName(taskName);
  const category=mistralModelCategory(stage);
  const stageDefault=MISTRAL_STAGE_DEFAULT_MODELS[stage]||'mistral-small-2603';
  const globalModel=env('MISTRAL_MODEL',stageDefault);
  const categoryModel=category==='DEFAULT'?'':env(`MISTRAL_MODEL_${category}`,'');
  const stageModel=env(`MISTRAL_MODEL_${stage.toUpperCase()}`,'');
  return {stage,category,model:stageModel||categoryModel||globalModel||stageDefault,source:stageModel?'stage':categoryModel?'category':env('MISTRAL_MODEL','')?'global':'optimized_default'};
}
function mistralModelCandidates(taskName=''){
  const route=mistralModelForStage(taskName),fallbacks=MISTRAL_MODEL_FAMILY_FALLBACKS[route.model]||[];
  return {...route,candidates:[route.model,...fallbacks].filter((value,index,array)=>value&&array.indexOf(value)===index)};
}
function publicMistralModelRouting(){
  return Object.fromEntries(['themes','scenes45','scenes916','caption','audio','flowMaster'].map(stage=>{const route=mistralModelCandidates(stage);return [stage,{model:route.model,candidates:route.candidates,category:route.category,source:route.source,adjustableReasoning:mistralSupportsAdjustableReasoning(route.model)}]}));
}
function activeProviderInfo(taskName='') {
  const provider = 'mistral'; // Mono-motor Mistral definitivo
  const route=mistralModelCandidates(taskName),keys=mistralApiKeys();
  return { provider, key: keys[0]||'', keys, keyCount:keys.length, model: route.model, modelCandidates:route.candidates, modelStage:route.stage, modelCategory:route.category, modelSource:route.source };
}

const THEME_ITEM_SCHEMA={type:'OBJECT',properties:{id:{type:'STRING'},title:{type:'STRING'},angle:{type:'STRING'},centralQuestion:{type:'STRING'},editorialPromise:{type:'STRING'},technicalTruth:{type:'STRING'},why:{type:'STRING'},visualDirection:{type:'STRING'}},additionalProperties:true};
const THEMES_RESPONSE_SCHEMA={type:'OBJECT',properties:{topics:{type:'ARRAY',items:THEME_ITEM_SCHEMA}},required:['topics'],additionalProperties:true};
const SCENE45_SCHEMA={type:'OBJECT',properties:{number:{type:'INTEGER'},title:{type:'STRING'},lines:{type:'ARRAY',items:{type:'STRING'}},prompt:{type:'STRING'}},additionalProperties:true};
const SCENES45_RESPONSE_SCHEMA={type:'OBJECT',properties:{title:{type:'STRING'},scenes45:{type:'ARRAY',items:SCENE45_SCHEMA}},required:['scenes45'],additionalProperties:true};
const SCENE916_SCHEMA={type:'OBJECT',properties:{number:{type:'INTEGER'},motionPrompt:{type:'STRING'}},additionalProperties:true};
const SCENES916_RESPONSE_SCHEMA={type:'OBJECT',properties:{motionScenes:{type:'ARRAY',items:SCENE916_SCHEMA}},required:['motionScenes'],additionalProperties:true};
const CAPTION_RESPONSE_SCHEMA={type:'OBJECT',properties:{lines:{type:'ARRAY',items:{type:'STRING'}},hashtags:{type:'ARRAY',items:{type:'STRING'}},socialCaption:{type:'STRING'}},additionalProperties:true};
const AUDIO_RESPONSE_SCHEMA={type:'OBJECT',properties:{acts:{type:'ARRAY',items:{type:'OBJECT',properties:{act:{type:'INTEGER'},name:{type:'STRING'},duration:{type:'STRING'},description:{type:'STRING'}},required:['act','name','duration','description']}}},required:['acts'],additionalProperties:true};

function jsonSchemaForMistral(value){
  if(Array.isArray(value))return value.map(jsonSchemaForMistral);
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const [key,current] of Object.entries(value)){
    if(key==='type'){
      const typeMap={OBJECT:'object',ARRAY:'array',STRING:'string',INTEGER:'integer',NUMBER:'number',BOOLEAN:'boolean',NULL:'null'};
      out.type=typeMap[String(current||'').toUpperCase()]||String(current||'').toLowerCase();
    }else out[key]=jsonSchemaForMistral(current);
  }
  return out;
}
function mistralSchemaName(taskName){
  const value=String(taskName||'inkvortex_output').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,60);
  return value||'inkvortex_output';
}
function mistralResponseFormat(taskName,responseSchema){
  if(!responseSchema)return {type:'json_object'};
  return {type:'json_schema',json_schema:{name:mistralSchemaName(taskName),strict:false,schema:jsonSchemaForMistral(responseSchema)}};
}
function isMistralStructuredOutputCompatibilityError(status,message){
  return Number(status)===400&&/(?:response[_ -]?format|json[_ -]?schema|structured output|schema|unsupported|not supported|invalid)/i.test(String(message||''));
}

function normalizeProviderResult(taskName,result){return result;}

function mockResponseForTask(taskName,prompt=''){
  if(taskName==='suggest-themes')return {topics:Array.from({length:5},(_,i)=>({
    id:`mock-theme-${i+1}`,
    title:['O detalhe invisível que muda toda a leitura do processo','Quando a matéria responde antes do resultado aparecer','A pista silenciosa que revela a verdadeira causa do erro','O mecanismo escondido por trás da aparência perfeita','Como um pequeno sinal físico redefine a decisão técnica'][i],
    angle:'Investigar uma relação material específica, acompanhando o comportamento da superfície antes, durante e depois da intervenção técnica.',
    centralQuestion:'Que descoberta concreta permite entender por que a matéria reage de maneira diferente quando processo, preparo e uso real se encontram?',
    editorialPromise:'Explicar a descoberta com progressão visual, clareza técnica e consequências práticas para quem produz, aplica, mantém ou avalia o resultado.',
    technicalTruth:'O resultado depende da interação observável entre matéria, preparação, deposição, transformação, controle do processo e condições reais de uso.',
    why:'Prende porque transforma um sinal discreto, normalmente ignorado, em uma pista útil para prever qualidade, falha, durabilidade e decisão técnica.',
    visualDirection:'Mostrar uma evidência material reconhecível em primeiro plano, com comparação de estados e uma ação física simples revelando causa, transformação e consequência.'
  }))};
  if(taskName==='scenes-45'){
    const prompts=Array.from({length:5},(_,i)=>`Composição editorial estática ${i+1}, vertical 9:16, construída em torno de um único protagonista material com leitura imediata. O elemento principal ocupa a área central inferior do quadro e apresenta espessura, textura, brilho, acabamento, bordas e pequenas irregularidades com precisão fotográfica. A superfície exibe uma evidência técnica concreta, como diferença de aderência, relevo desigual, resíduo, microfalha, deformação localizada ou contraste entre duas regiões do mesmo material. A relação entre causa e resultado permanece visível no próprio objeto ou em uma comparação lado a lado, permitindo compreender o fenômeno sem depender de texto explicativo. O primeiro plano concentra a matéria examinada; o plano médio fornece escala e contexto de uso; o fundo contém somente equipamentos, amostras ou superfícies necessários para identificar o ambiente profissional. A iluminação revela volume, transparência, reflexos e desgaste de acordo com as propriedades reais de cada material. InkVortex Brasil aparece discretamente gravada, impressa ou etiquetada em um único componente físico, subordinada à evidência principal. A fotografia possui acabamento premium, profundidade convincente, nitidez seletiva e organização espacial clara, com cada elemento contribuindo para a compreensão técnica da cena.`);
    return {title:'Quando a matéria revela o que o processo tentou esconder',scenes45:Array.from({length:5},(_,i)=>({number:i+1,title:['O primeiro sinal material que coloca toda a leitura em dúvida','A pista visual que organiza a investigação técnica','O mecanismo central aparece na própria superfície','A consequência prática mostra por que o detalhe importa','A resposta final reconecta causa, matéria e resultado'][i],lines:['A cena apresenta uma descoberta concreta em linguagem editorial acessível.','Cada linha acrescenta contexto, mecanismo e consequência de forma progressiva.','O conjunto mantém clareza visual e conteúdo suficiente para sustentar a curiosidade.'],prompt:prompts[i]}))};
  }
  if(taskName==='scenes-916'){
    const motions=Array.from({length:5},(_,i)=>`O clipe ${i+1} começa com o protagonista material já visível e estável no enquadramento vertical. A ação principal inicia de forma clara e contínua: a superfície desliza, dobra, recebe pressão, libera partículas, acompanha uma curvatura ou muda de posição conforme o fenômeno técnico representado. O movimento segue uma única direção compreensível, com ritmo controlado e sem saltos. O material reage segundo suas propriedades, mostrando tensão, flexão, aderência, fluxo, vibração, resistência ou acomodação física sem deformações aleatórias. Elementos secundários próximos respondem apenas quando há causa concreta, como fibras que se alinham, resíduos que se afastam, reflexos que mudam com a curvatura ou uma ferramenta que acompanha o contato. A câmera realiza no máximo uma aproximação lenta e contínua, subordinada ao fenômeno. Não há cortes, transições, troca de ambiente, montagem interna, narração, diálogo, trilha ou texto sobreposto. A marca InkVortex Brasil permanece estável e legível no mesmo elemento físico durante todo o clipe. O movimento desacelera naturalmente e termina com a consequência material plenamente visível, preservando proporções, cores, textura e identidade da referência GPT.`);
    return {motionScenes:motions.map((motionPrompt,i)=>({number:i+1,motionPrompt}))};
  }
  if(taskName==='caption-only')return {lines:[
    '🔍 O que parece apenas acabamento pode carregar uma história inteira sobre origem, processo e autenticidade.',
    '🧵 No tecido, pequenas pistas materiais ajudam a ligar a peça ao lote, ao produtor e às etapas que deram forma ao resultado.',
    '⚙️ Quando essas informações acompanham o produto, a verificação deixa de depender apenas da aparência e ganha uma referência rastreável.',
    '🛡️ Isso não elimina toda fraude, mas torna a cópia mais fácil de identificar e aumenta a responsabilidade ao longo da cadeia.',
    '🌍 Para quem produz, vende ou compra, o valor está em transformar procedência e cuidado em informação acessível.',
    '💡 A tecnologia faz sentido quando aproxima o dado técnico da decisão humana, sem esconder o processo atrás de uma sigla.',
    '🎯 No fim, confiança não nasce do discurso mais longo, e sim de evidências claras que o leitor consegue compreender e verificar.'
  ],hashtags:['#InkVortexBrasil','#TecnologiaTextil','#ImpressaoProfissional','#Rastreabilidade','#Inovacao']};
  throw new Error(`Mock inexistente para ${taskName}`);
}
function maximumOutputTokens(model,provider=activeProvider()) {
  const explicit=Number(env(provider==='mistral'?'MISTRAL_MAX_OUTPUT_TOKENS':'GEMINI_MAX_OUTPUT_TOKENS',''));
  if(Number.isFinite(explicit)&&explicit>=4096)return explicit;
  const value=String(model||'').toLowerCase();
  if(provider==='mistral'){
    if(value.includes('medium')||value.includes('large'))return 65536;
    if(value.includes('small'))return 32768;
    return 16384;
  }
  if(value.includes('gemini-3.5-flash'))return 65536;
  if(value.includes('gemini-3'))return 65536;
  if(value.includes('gemini-2.5'))return 65536;
  return 8192;
}
function mistralSupportsAdjustableReasoning(model) {
  const value=String(model||'').trim().toLowerCase();
  return value==='mistral-small-latest'||value==='mistral-small-2603'||value.startsWith('mistral-small-2603-');
}
function defaultMistralReasoningForStage(stage){
  return 'none';
}
function normalizeMistralReasoningEffort(value,stage){
  const normalized=String(value||'').trim().toLowerCase();
  if(normalized==='high'||normalized==='none')return normalized;
  if(['off','disabled','false','0','low'].includes(normalized))return 'none';
  if(normalized==='medium')return defaultMistralReasoningForStage(stage);
  return defaultMistralReasoningForStage(stage);
}
function mistralReasoningValuesFromError(message){
  const text=String(message||'').toLowerCase();
  const values=[];
  if(text.includes('reasoningeffort.high')||/supported values[^;]*\bhigh\b/i.test(text))values.push('high');
  if(text.includes('reasoningeffort.none')||/supported values[^;]*\bnone\b/i.test(text))values.push('none');
  return [...new Set(values)];
}
function isMistralReasoningCompatibilityError(status,message) {
  return Number(status)===400&&/(reasoning prompt mode is not enabled|reasoning.*(?:not enabled|unsupported|not supported)|prompt[_ ]mode.*reasoning|reasoning_effort.*(?:unsupported|not supported|invalid)|supported values.*reasoningeffort)/i.test(String(message||''));
}
function providerCapabilities(info=activeProviderInfo()) {
  const model=String(info&&info.model||'');
  const provider=String(info&&info.provider||activeProvider());
  const mistralReasoning=provider==='mistral'&&mistralSupportsAdjustableReasoning(model);
  return {
    provider,model,
    contextTokens:provider==='mistral'&&/(small|medium|large)/i.test(model)?262144:null,
    maxOutputTokens:maximumOutputTokens(model,provider),
    structuredOutput:true,
    profileMode:apiProfileMode(),
    adaptiveTokenBudget:apiProfileMode()==='adaptive',
    thinkingControl:provider==='gemini'?'thinking_level':(mistralReasoning?'reasoning_effort':null),
    adjustableReasoning:provider==='gemini'||mistralReasoning,
    sampling:provider==='mistral'?'temperature_sem_top_p':'temperature_e_top_p',
    ideaResearch:false
  };
}

function adaptiveTokenError(error){return /max_tokens_reached|max_output_tokens|finish_reason=length|JSON invalido ou incompleto|fora do formato JSON|truncad|incomplet/i.test(String(error&&error.message||error));}
function interactionWasTruncated(data){const text=JSON.stringify({status:data&&data.status,incomplete:data&&data.incomplete_details,reason:data&&data.finish_reason,stop:data&&data.stop_reason});return /max[_ -]?(?:output[_ -]?)?tokens|length|incomplete/i.test(text);}

async function generateJsonWithProviderOnce(prompt, config = {}) {
  const taskName=String(config.taskName||'generation').trim()||'generation';
  const info = activeProviderInfo(taskName);
  if (!info.key) throw new Error(`${info.provider === 'mistral' ? 'MISTRAL_API_KEY' : 'GEMINI_API_KEY'} nao configurada. Rode o inicializador do provedor e informe sua chave.`);
  const providerMax=maximumOutputTokens(info.model,info.provider);
  const requestedMax=Number(config.maxOutputTokens)||providerMax;
  const maxOutputTokens=Math.max(4096,Math.min(requestedMax,providerMax));
  const temperature=Number.isFinite(Number(config.temperature))?Number(config.temperature):0.6;
  const topP=Number.isFinite(Number(config.topP))?Number(config.topP):undefined;
  const thinkingLevel=config.thinkingLevel||'medium';
  const reasoningEffort=config.reasoningEffort||defaultMistralReasoningForStage(config.profileName||canonicalStageName(taskName));
  const timeoutMs=Number.isFinite(Number(config.timeoutMs))?Number(config.timeoutMs):DEFAULT_API_TIMEOUT_MS;
  const systemInstruction=[API_CONTRACTS.system,config.contract].filter(Boolean).join('\n\n');
  const startedAt = Date.now();
  let response;
  if (info.provider === 'mistral') {
    const requestedModel=info.model;
    const modelCandidates=(Array.isArray(info.modelCandidates)&&info.modelCandidates.length?info.modelCandidates:[requestedModel]).filter(Boolean);
    const keyCandidates=(Array.isArray(info.keys)&&info.keys.length?info.keys:[info.key]).filter(Boolean);
    const requestedReasoningEffort=String(reasoningEffort||'none');
    const reasoningStage=config.profileName||canonicalStageName(taskName);
    const mistralEndpoint=env('MISTRAL_API_URL','https://api.mistral.ai/v1/chat/completions');
    let mistralAttempts=0,lastResponse=null,lastError=null,lastModel=requestedModel,lastKeySlot=1;
    let modelFallback=false,keyFallback=false,reasoningFallback=false,responseFormatFallback=false;

    const telemetry=(ok,extra={})=>writeApiTelemetry({
      ok,provider:info.provider,model:lastModel,requestedModel,modelStage:info.modelStage,modelCategory:info.modelCategory,modelSource:info.modelSource,
      modelCandidates,keySlot:lastKeySlot,keyCount:keyCandidates.length,modelFallback,keyFallback,
      taskName,stageProfile:config.profileName||canonicalStageName(taskName),endpoint:mistralEndpoint,
      requestedMaxOutputTokens:requestedMax,maxOutputTokens,temperature,topP:config.mistralUseTopP===true?topP:undefined,
      requestedReasoningEffort,reasoningFallback,responseFormatFallback,responseSchema:Boolean(config.responseSchema),
      timeoutMs,adaptiveAttempt:config.adaptiveAttempt||1,attempts:mistralAttempts,durationMs:Date.now()-startedAt,inputChars:String(prompt||'').length,...extra
    });

    try{
      modelLoop:
      for(let modelIndex=0;modelIndex<modelCandidates.length;modelIndex++){
        const currentModel=modelCandidates[modelIndex];
        lastModel=currentModel;
        modelFallback=modelIndex>0;
        const reasoningSupported=mistralSupportsAdjustableReasoning(currentModel);
        let appliedReasoningEffort=reasoningSupported?normalizeMistralReasoningEffort(requestedReasoningEffort,reasoningStage):null;

        for(let keyIndex=0;keyIndex<keyCandidates.length;keyIndex++){
          const currentKey=keyCandidates[keyIndex];
          lastKeySlot=keyIndex+1;
          keyFallback=keyIndex>0;
          reasoningFallback=false;
          responseFormatFallback=false;
          const mistralBody={
            model:currentModel,
            messages:[
              {role:'system',content:`${API_CONTRACTS.system}\n\nFormato de entrega: JSON válido.`},
              {role:'user',content:`${String(config.contract||'').trim()}\n\n${prompt}\n\nFormato final: um único JSON válido.`}
            ],
            temperature,
            max_tokens:maxOutputTokens,
            response_format:mistralResponseFormat(taskName,config.responseSchema)
          };
          if(appliedReasoningEffort)mistralBody.reasoning_effort=appliedReasoningEffort;
          if(config.mistralUseTopP===true&&topP!==undefined){delete mistralBody.temperature;mistralBody.top_p=topP;}

          const performRequest=async()=>{
            const result=await fetchMistralWithRetry(mistralEndpoint,{
              method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${currentKey}`},body:JSON.stringify(mistralBody),signal:config.signal
            },timeoutMs);
            mistralAttempts+=result.attempts;
            const data=await result.response.json().catch(()=>({}));
            return {response:result.response,data};
          };

          let result=await performRequest();
          lastResponse=result.response;
          let data=result.data;
          let errorMessage=data.message||data.detail||data.error&&data.error.message||'resposta sem detalhe';

          for(let compatibilityPass=0;!lastResponse.ok&&compatibilityPass<2;compatibilityPass++){
            if(mistralBody.reasoning_effort&&!reasoningFallback&&isMistralReasoningCompatibilityError(lastResponse.status,errorMessage)){
              reasoningFallback=true;appliedReasoningEffort=null;delete mistralBody.reasoning_effort;
            }else if(mistralBody.response_format&&mistralBody.response_format.type==='json_schema'&&!responseFormatFallback&&isMistralStructuredOutputCompatibilityError(lastResponse.status,errorMessage)){
              responseFormatFallback=true;mistralBody.response_format={type:'json_object'};
            }else break;
            result=await performRequest();lastResponse=result.response;data=result.data;
            errorMessage=data.message||data.detail||data.error&&data.error.message||'resposta sem detalhe';
          }

          if(!lastResponse.ok){
            if(isMistralKeyFallbackStatus(lastResponse.status)&&keyIndex<keyCandidates.length-1)continue;
            if(isMistralModelAvailabilityError(lastResponse.status,errorMessage)&&modelIndex<modelCandidates.length-1)continue modelLoop;
            throw new Error(`Falha Mistral: http=${lastResponse.status}; model=${currentModel}; key_slot=${keyIndex+1}; parameter=api_request; tentativas=${mistralAttempts}; detalhe=${errorMessage}`);
          }

          const choice=data.choices&&data.choices[0];
          if(choice&&choice.finish_reason==='length')throw new Error(`Falha Mistral: model=${currentModel}; parameter=max_tokens; value=${maxOutputTokens}; motivo=max_tokens_reached.`);
          const output=extractMistralText(choice&&choice.message);
          let parsed;
          try{parsed=extractJson(output);}catch{throw new Error(`Falha Mistral: model=${currentModel}; parameter=response_format; motivo=JSON inválido ou incompleto.`);}
          telemetry(true,{httpStatus:lastResponse.status,outputChars:output.length,usageMetadata:data.usage||null,appliedReasoningEffort,reasoningSupported, responseFormatMode:mistralBody.response_format&&mistralBody.response_format.type});
          return parsed;
        }
      }
      throw lastError||new Error('Falha Mistral: nenhum modelo ou chave disponível concluiu a chamada.');
    }catch(error){
      lastError=error;mistralAttempts=Number(error&&error.mistralAttempts)||mistralAttempts||1;
      telemetry(false,{httpStatus:lastResponse&&lastResponse.status,error:sanitizeTelemetryMessage(error&&error.message?error.message:error)});
      if(isRetryableMistralNetworkError(error)&&!/^Falha Mistral:/i.test(String(error&&error.message||'')))throw new Error(`Falha Mistral: model=${lastModel}; parameter=connection; tentativas=${mistralAttempts}; motivo=conexão temporariamente indisponível após retentativas automáticas.`);
      throw error;
    }
  }
  let url='https://generativelanguage.googleapis.com/v1beta/interactions';
  let endpointFallback=false,responseFormatFallback=false,telemetryWritten=false;
  const writeGeminiTelemetry=(ok,extra={})=>{if(telemetryWritten)return;telemetryWritten=true;writeApiTelemetry({
    ok,provider:info.provider,model:info.model,taskName,stageProfile:config.profileName||canonicalStageName(taskName),endpoint:url,
    endpointFallback,responseFormatFallback,responseSchema:Boolean(config.responseSchema),requestedMaxOutputTokens:requestedMax,maxOutputTokens,
    temperature,topP,thinkingLevel,timeoutMs,adaptiveAttempt:config.adaptiveAttempt||1,durationMs:Date.now()-startedAt,...extra
  });};
  const geminiGenerationConfig=interactionGenerationConfigFor({temperature,topP,maxOutputTokens,thinkingLevel});
  const interactionPayload={model:info.model,input:prompt,store:false,system_instruction:systemInstruction,generation_config:geminiGenerationConfig};
  if(config.responseSchema)interactionPayload.response_format=[{type:'text',mime_type:'application/json',schema:config.responseSchema}];
  try{
    response=await fetchWithTimeout(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':info.key},body:JSON.stringify(interactionPayload),signal:config.signal},timeoutMs);
    if(response.status===404){endpointFallback=true;url='https://generativelanguage.googleapis.com/v1beta2/interactions';response=await fetchWithTimeout(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':info.key},body:JSON.stringify(interactionPayload),signal:config.signal},timeoutMs);}
    let data=await response.json().catch(()=>({}));
    let detail=data.error&&data.error.message?data.error.message:'';
    if(!response.ok&&interactionPayload.response_format&&/schema|responseSchema|response_schema|response_format/i.test(detail)){
      responseFormatFallback=true;delete interactionPayload.response_format;
      response=await fetchWithTimeout(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':info.key},body:JSON.stringify(interactionPayload),signal:config.signal},timeoutMs);
      data=await response.json().catch(()=>({}));
    }
    const usageMetadata=extractUsageMetadata(data);
    if(!response.ok){const errorMessage=data.error&&data.error.message?data.error.message:'resposta sem detalhe';writeGeminiTelemetry(false,{httpStatus:response.status,usageMetadata,error:sanitizeTelemetryMessage(errorMessage)});throw new Error(`Falha Gemini: http=${response.status}; model=${info.model}; parameter=api_request; detalhe=${errorMessage}`);}
    if(interactionWasTruncated(data))throw new Error(`Falha Gemini: model=${info.model}; parameter=max_output_tokens; value=${maxOutputTokens}; motivo=max_output_tokens_reached.`);
    const text=extractInteractionText(data);
    try{const parsed=extractJson(text);writeGeminiTelemetry(true,{httpStatus:response.status,usageMetadata,outputChars:text.length});return parsed;}
    catch{require('fs').writeFileSync('debug-llm.txt', text);writeGeminiTelemetry(false,{httpStatus:response.status,usageMetadata,outputChars:text.length,error:'JSON invalido ou incompleto'});throw new Error(`Falha Gemini: model=${info.model}; parameter=response_format; motivo=JSON invalido ou incompleto.`);}
  }catch(error){writeGeminiTelemetry(false,{httpStatus:response&&response.status,error:sanitizeTelemetryMessage(error&&error.message?error.message:error)});throw error;}
}

async function generateJsonWithProvider(prompt, config={}) {
  const taskName=String(config.taskName||'generation');
  if(String(env('INKVORTEX_MOCK_API','')).trim()==='1')return mockResponseForTask(taskName,prompt);
  const info=activeProviderInfo(taskName);
  const profile=resolvedStageProfile(taskName,info.provider,config);
  const providerMax=maximumOutputTokens(info.model,info.provider);
  const ceiling=Math.min(providerMax,Math.max(4096,profile.maxOutputTokens));
  let budget=Math.min(ceiling,Math.max(4096,profile.initialOutputTokens));
  let lastError;
  const maxAdaptiveAttempts=apiProfileMode()==='adaptive'?3:1;
  for(let adaptiveAttempt=1;adaptiveAttempt<=maxAdaptiveAttempts;adaptiveAttempt++){
    try{return await generateJsonWithProviderOnce(prompt,{...config,...profile,maxOutputTokens:budget,adaptiveAttempt});}
    catch(error){lastError=error;if(!adaptiveTokenError(error)||budget>=ceiling||adaptiveAttempt===maxAdaptiveAttempts)throw error;const next=Math.min(ceiling,Math.max(budget+4096,Math.ceil(budget*1.6)));writeApiTelemetry({taskName:`${taskName}-token-escalation`,ok:false,provider:info.provider,model:info.model,fromTokens:budget,toTokens:next,reason:sanitizeTelemetryMessage(error.message)});budget=next;}
  }
  throw lastError||new Error(`Falha na etapa ${taskName}`);
}

const VIDEO_REFERENCE_WORDS=Object.freeze({um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5});

const PORTUGUESE_NUMBER_VALUES=Object.freeze({zero:0,um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,onze:11,doze:12,treze:13,catorze:14,quatorze:14,quinze:15,dezesseis:16,dezasseis:16,dezessete:17,dezassete:17,dezoito:18,dezenove:19,vinte:20,trinta:30,quarenta:40,cinquenta:50,sessenta:60,setenta:70,oitenta:80,noventa:90,cem:100,cento:100,duzentos:200,duzentas:200,trezentos:300,trezentas:300,quatrocentos:400,quatrocentas:400,quinhentos:500,quinhentas:500,seiscentos:600,seiscentas:600,setecentos:700,setecentas:700,oitocentos:800,oitocentas:800,novecentos:900,novecentas:900,mil:1000});
const NUMERIC_UNIT_WORDS=new Set(['ano','anos','mes','meses','dia','dias','hora','horas','minuto','minutos','segundo','segundos','grau','graus','celsius','kelvin','metro','metros','milimetro','milimetros','centimetro','centimetros','micrometro','micrometros','litro','litros','mililitro','mililitros','quilo','quilos','quilograma','quilogramas','grama','gramas','porcento','percentual','percentuais','vez','vezes','leitura','leituras','ciclo','ciclos','dpi','fps','nm']);
const TRACKED_NAMED_REFERENCES=Object.freeze(['epson','mimaki','roland','mutoh','canon','brother','hewlett packard','avery dennison','hanna instruments','vutek','drytac','flir','adobe','corel','dupont','oeko tex','iso 20471']);
function normalizeCaptionResult(result){return {socialCaption:captionJsonToText(result)}}
async function generateStage(config){
  const rawResult=await generateJsonWithProvider(config.prompt,{taskName:config.taskName,profileName:config.profileName,responseSchema:config.responseSchema,contract:config.contract,timeoutMs:config.timeoutMs,initialOutputTokens:config.initialOutputTokens,tokenCeiling:config.tokenCeiling,signal:config.signal});
  return normalizeProviderResult(config.taskName,rawResult);
}
function validateCompleteGenerationPayload(payload){
  const topic=sourceTopicFromPayload(payload||{});
  if(!String(topic.title||payload&&payload.brief||'').trim())throw new Error('Selecione uma ideia ou informe um assunto.');
  return payload;
}
function validateThemeGenerationPayload(payload){if(!String(payload&&payload.brief||'').trim())throw new Error('Digite um assunto antes de gerar ideias.');return payload;}
async function generateScenes45(payload,options={}){
  const basePrompt=buildScenes45Context(payload);
  const raw=await generateStage({taskName:'scenes-45',profileName:'scenes45',prompt:basePrompt,responseSchema:SCENES45_RESPONSE_SCHEMA,contract:API_CONTRACTS.scenes45,signal:options.signal});
  return normalizeScenes45(raw);
}
async function generateScenes916(payload,scenes45,options={}){
  const basePrompt=buildScenes916Context(payload,scenes45);
  const raw=await generateStage({taskName:'scenes-916',profileName:'scenes916',prompt:basePrompt,responseSchema:SCENES916_RESPONSE_SCHEMA,contract:API_CONTRACTS.scenes916,signal:options.signal});
  return normalizeScenes916(raw);
}
async function generateCaption(payload,options={}){
  const basePrompt=buildCaptionContext(payload);
  const result=await generateStage({taskName:'caption-only',profileName:'caption',prompt:basePrompt,responseSchema:CAPTION_RESPONSE_SCHEMA,contract:API_CONTRACTS.caption,signal:options.signal});
  return normalizeCaptionResult(result);
}
async function generateAudioPrompt(payload,options={}){
  const basePrompt=buildAudioContext(payload);
  const result=await generateStage({taskName:'generate-audio',profileName:'audio',prompt:basePrompt,responseSchema:AUDIO_RESPONSE_SCHEMA,contract:API_CONTRACTS.audio,signal:options.signal});
  
  let styleParts = (payload.style || 'Cinematic').split(' - ');
  let estilo = styleParts[0];
  let variacao = styleParts.length > 1 ? styleParts[1] : '';

  let formattedPrompt = `[CONTRATO MUSICAL MISTRAL 60S - INKI VORTÉX BRASIL]\n`;
  formattedPrompt += `Idioma Vocal & Fonética: Português do Brasil (pt-BR - Grafia Vocal: Inki Vortéx Brasil)\n`;
  formattedPrompt += `Estilo Musical: ${estilo}\n`;
  if (variacao) {
    formattedPrompt += `Variação & Arranjo: ${variacao}\n\n`;
  } else {
    formattedPrompt += '\n';
  }
  if (result.acts && Array.isArray(result.acts)) {
    formattedPrompt += result.acts.map(a => `${a.name} (${a.duration}):\n${a.description}`).join('\n\n');
  } else {
    formattedPrompt = result.prompt || 'Erro na formatação.';
  }
  return { prompt: formattedPrompt };
}
const FLOWMASTER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    introduction: { type: 'string', description: 'Visão geral da direção de fotografia e formato.' },
    scenes: {
      type: 'array',
      description: 'As 5 cenas descritas em detalhes.',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          description: { type: 'string', description: 'Descrição da cena, câmera, iluminação e ação física.' },
          transition: { type: 'string', description: 'Transição orgânica para a próxima cena.' }
        },
        required: ['number', 'description', 'transition']
      }
    }
  },
  required: ['introduction', 'scenes']
};
function buildFlowMasterContext(payload){
  const c = payload.campaign || {};
  let scenesStr = (c.scenes || []).map(s => `Cena ${s.number || s.no}: ${s.title}\nAção e Movimento: ${s.geminiMotion || s.prompt || ''}`).join('\n\n');
  const context = {
    topic: c.topic ? c.topic.title : '',
    scenes: scenesStr
  };
  
  let fileText = '';
  try {
     fileText = fs.readFileSync(path.join(__dirname, '..', 'flow', 'flow.txt'), 'utf8');
  } catch(e) {
     fileText = `Crie um roteiro master fluido conectando essas 5 cenas.`;
  }
  
  return `${fileText}\n\n[DADOS DA MINISSÉRIE]\nTópico: ${context.topic}\n\nCenas Brutas de Movimento:\n${context.scenes}\n`;
}
async function generateFlowMaster(payload,options={}){
  const basePrompt=buildFlowMasterContext(payload);
  const result=await generateStage({taskName:'generate-flow',profileName:'flowMaster',prompt:basePrompt,responseSchema:FLOWMASTER_RESPONSE_SCHEMA,contract:API_CONTRACTS.flowMaster,signal:options.signal});
  
  let formattedPrompt = result.introduction ? result.introduction + "\n\n" : "";
  if (Array.isArray(result.scenes)) {
    result.scenes.forEach(scene => {
      formattedPrompt += `**Cena ${scene.number||'?'}:**\n${scene.description||''}\n*Transição:* ${scene.transition||''}\n\n`;
    });
  } else if (result.prompt) {
    formattedPrompt = result.prompt;
  }
  
  return { prompt: formattedPrompt.trim() };
}

const DOCUMENTARY_RESPONSE_SCHEMA={type:'object',properties:{script:{type:'string',description:'O roteiro longo e documental completo que funde todas as campanhas selecionadas.'}},required:['script']};
function buildDocumentaryContext(payload){
  const campaigns = payload.campaigns || [];
  let contextStr = campaigns.map(c => `Minissérie ${c.number||'??'}: ${c.topic?.title || c.title || ''}\nCenas:\n${(c.scenes || []).map(s=>`- ${s.title||''}: ${(s.lines||[]).join(' ')}`).join('\n')}\nLegenda Social:\n${c.socialCaption || ''}`).join('\n\n---\n\n');
  return `Você é um diretor e roteirista de documentários do YouTube (estilo Canal Dark/Faceless) especializado em impressão digital e tecnologia (Epson, Mimaki, DTG, DTF, etc).\n\nSeu objetivo é fundir as seguintes minisséries (campanhas isoladas) em um ÚNICO Roteiro de Narração Contínuo e Longo.\n\nCONTEÚDO BASE DAS MINISSÉRIES:\n${contextStr}\n\nDIRETRIZES:\n1. Escreva um roteiro épico, engajador, técnico e fluido que conecte esses assuntos de forma inteligente.\n2. Crie um Gancho Inicial (Hooks) nos primeiros segundos.\n3. Desenvolva os argumentos com profundidade usando o conteúdo das minisséries.\n4. Crie uma Conclusão impactante.\n5. O texto deve ser 100% narração (voiceover), lido de forma contínua por um locutor, sem rubricas de edição ou marcações de câmera. Não escreva "Cena 1" ou "[Música sobe]". Apenas as palavras exatas que o locutor vai falar.\n6. Retorne o texto completo da narração dentro da propriedade 'script' do JSON.`;
}
async function generateDocumentary(payload,options={}){
  const basePrompt=buildDocumentaryContext(payload);
  const raw=await generateJsonWithProvider(basePrompt,{taskName:'generate-documentary',profileName:'flowMaster',responseSchema:DOCUMENTARY_RESPONSE_SCHEMA,signal:options.signal});
  
  // Salvar no disco para não perder
  const docDir = path.join(ROOT, 'render', 'documentarios');
  if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });
  const docId = `Documentario_${Date.now()}`;
  const filename = `${docId}.txt`;
  fs.writeFileSync(path.join(docDir, filename), raw.script, 'utf-8');
  
  // Salvar Dossiê
  const dossier = {
    id: docId,
    campaigns: (payload.campaigns || []).map(c => c.id || c.number),
    campaignTitles: (payload.campaigns || []).map(c => c.topic?.title || c.title || `Minissérie ${c.number}`),
    script: raw.script,
    audioPath: null,
    videoPath: null,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(docDir, `${docId}.json`), JSON.stringify(dossier, null, 2), 'utf-8');
  
  return { script: raw.script, filename: filename, docId: docId };
}

const { EdgeTTS } = require('node-edge-tts');

function renderDocumentaryVideo(payload) {
  // NOTE: This logic is now handled in createDocJob()
  return { ok: true, message: 'Rota deprecada. Use /start' };
}

const DOC_JOBS = new Map();

function publicDocJob(job) {
  return job ? { jobId: job.jobId, status: job.status, stage: job.stage, step: job.step, total: job.total, detail: job.detail, error: job.error, result: job.status === 'done' ? job.result : undefined } : null;
}

function createDocJob(payload) {
  const jobId = `docjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
  const controller = new AbortController();
  const job = { jobId, status: 'running', stage: 'queued', step: 0, total: 4, detail: 'Preparando a Renderização', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null, controller };
  DOC_JOBS.set(jobId, job);
  
  Promise.resolve().then(async () => {
    try {
      const { script, campaigns, docFilename, voiceId } = payload;
      if (!script) throw new Error('Roteiro vazio.');
      
      const docDir = path.join(ROOT, 'render', 'documentarios');
      if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });
      const baseName = docFilename ? docFilename.replace('.txt', '') : `Documentario_${Date.now()}`;
      const audioPath = path.join(docDir, `${baseName}.mp3`);
      const finalVideoPath = path.join(docDir, `${baseName}_FINAL.mp4`);
      const listPath = path.join(docDir, `${baseName}_list.txt`);
      
      // 1. Áudio
      Object.assign(job, { stage: 'audio', step: 1, detail: 'Forjando Áudio Neural (Edge-TTS)...', updatedAt: Date.now() });
      if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
         Object.assign(job, { detail: 'Áudio Neural já forjado. Pulando Etapa 1...', updatedAt: Date.now() });
      } else {
         const tts = new EdgeTTS({ voice: voiceId || 'pt-BR-AntonioNeural', lang: 'pt-BR', outputFormat: 'audio-24khz-48kbitrate-mono-mp3', timeout: 300000 });
         await tts.ttsPromise(script, audioPath);
      }
      let dur = script.length / 15;
      try {
         const ffprobeCmd = `${getFfprobePath()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
         const { stdout } = require('child_process').execSync(ffprobeCmd);
         dur = parseFloat(stdout.trim());
      } catch(e) {
         console.warn("ffprobe falhou, usando duracao estimada por caracteres.");
      }
      
      const numImages = Math.max(10, Math.ceil(dur / 10)); // 1 image per 10s, min 10
      
      // 2 e 3. Pulando ou Forjando Imagens
      const imgDir = path.join(docDir, baseName + '_images');
      let skipImages = false;
      
      if (fs.existsSync(imgDir)) {
         const existingImgs = fs.readdirSync(imgDir).filter(f => f.endsWith('.jpg'));
         // A API livre falha muito. Se tivermos pelo menos 5 imagens salvas, consideramos aceitável para pular e não forçar refazer tudo.
         if (existingImgs.length >= 5) {
             skipImages = true;
         }
      }
      
      let prompts = [];
      const generatedImages = [];
      if (skipImages) {
         Object.assign(job, { stage: 'imagen', step: 3, detail: `Imagens Visuais já forjadas (${numImages}). Pulando Etapas 2 e 3...`, updatedAt: Date.now() });
         const existingImgs = fs.readdirSync(imgDir).filter(f => f.endsWith('.jpg')).sort();
         existingImgs.forEach((f, i) => {
            if (i < numImages) generatedImages.push(path.join(imgDir, f));
         });
      } else {
          // 2. Extrair Prompts Visuais (Mistral/Gemini via VORTEX 8 gen function)
          Object.assign(job, { stage: 'prompts', step: 2, detail: `Desenhando ${numImages} Prompts Visuais com IA...`, updatedAt: Date.now() });
          const promptsContext = `Você é um Diretor de Fotografia. Leia o roteiro e crie exatamente ${numImages} prompts em INGLÊS que ilustrem sequencialmente a narrativa. Descreva imagens ricas e hiper-realistas para um gerador de imagens, em formato 16:9. Sem marcadores de tempo. Foco em detalhes visuais, cyberpunk, tecidos, futurismo e biologia quando aplicável.\nRoteiro:\n${script.substring(0, 4000)}... (cortado)`;
          
          const rawPrompts = await generateJsonWithProvider(promptsContext, {
             taskName: 'generate-doc-prompts',
             profileName: 'flowMaster', // Using flowMaster (mistral-large-latest) as requested by the Director
             responseSchema: { type: 'object', properties: { prompts: { type: 'array', items: { type: 'string' } } }, required: ['prompts'] },
             signal: controller.signal
          });
          prompts = Array.isArray(rawPrompts.prompts) ? rawPrompts.prompts : [];
          if (prompts.length === 0) prompts = Array(numImages).fill("futuristic highly detailed textile digital printing 16:9 cinematic");
          // Pad to exact number
          while(prompts.length < numImages) prompts.push(prompts[prompts.length-1]);
          prompts = prompts.slice(0, numImages);
          
          // 3. Gerar Imagens com Pollinations AI (FLUX)
          Object.assign(job, { stage: 'imagen', step: 3, detail: `Forjando Arte Visual (${numImages} Imagens)...`, updatedAt: Date.now() });
          
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir);
      }
      
      if (!skipImages) {
          // To speed up, we can fetch images in batches of 5 to avoid blocking but not overwhelm
          const batchSize = 5;
          for (let i = 0; i < prompts.length; i += batchSize) {
            if (job.status === 'cancelling') throw new Error('Cancelado pelo usuário.');
            Object.assign(job, { detail: `Materializando Arte Visual (Lote ${Math.floor(i/batchSize)+1}, Imagens ${i+1} a ${Math.min(i+batchSize, prompts.length)} de ${numImages})...`, updatedAt: Date.now() });
            
            const batch = prompts.slice(i, i + batchSize);
            const promises = batch.map(async (promptText, index) => {
              const absoluteIndex = i + index;
              const seed = Math.floor(Math.random() * 1000000);
              const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptText)}?width=1920&height=1080&nologo=true&seed=${seed}`;
              try {
                const res = await fetchWithTimeout(url, { method: 'GET', signal: controller.signal }, 60000);
                if (res.ok) {
                  const arrayBuf = await res.arrayBuffer();
                  const buffer = Buffer.from(arrayBuf);
                  const imgPath = path.join(imgDir, `img_${String(absoluteIndex).padStart(3,'0')}.jpg`);
                  fs.writeFileSync(imgPath, buffer);
                  return imgPath;
                }
              } catch(e) { console.error('Falha na imagem', absoluteIndex, e.message); }
              return null;
            });
            
            const results = await Promise.all(promises);
            for (const res of results) {
              if (res) generatedImages.push(res);
            }
          }
      }
      
      generatedImages.sort();
      
      if (generatedImages.length === 0) throw new Error('Nenhuma imagem foi gerada com sucesso pela API livre.');
      
      // 4. Montar Vídeo FFmpeg
      Object.assign(job, { stage: 'ffmpeg', step: 4, detail: 'Aplicando Ken Burns e finalizando Montagem...', updatedAt: Date.now() });
      const listContent = generatedImages.map(p => `file '${p.replace(/'/g, "'\\''")}'\nduration 10`).join('\n') + `\nfile '${generatedImages[generatedImages.length-1].replace(/'/g, "'\\''")}'`;
      fs.writeFileSync(listPath, listContent, 'utf-8');
      
      const ffmpegCmd = `${getFfmpegPath()} -y -f concat -safe 0 -i "${listPath}" -i "${audioPath}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.001,1.5)':d=250:fps=25" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${finalVideoPath}"`;
      
      await new Promise((resolve, reject) => {
        require('child_process').exec(ffmpegCmd, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      
      try { fs.unlinkSync(listPath); } catch(e){}
      
      // Update Dossiê
      try {
        const jsonPath = path.join(docDir, `${baseName}.json`);
        if (fs.existsSync(jsonPath)) {
          const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          d.audioPath = audioPath;
          d.videoPath = finalVideoPath;
          fs.writeFileSync(jsonPath, JSON.stringify(d, null, 2), 'utf-8');
        }
      } catch(e) {}
      
      if (job.status !== 'cancelling') {
        Object.assign(job, { status: 'done', stage: 'done', step: 4, detail: 'Documentário Finalizado com Sucesso!', result: { audio: `${baseName}.mp3`, video: `${baseName}_FINAL.mp4` }, updatedAt: Date.now() });
      }
    } catch (error) {
      Object.assign(job, { status: 'error', error: error.message || String(error), detail: 'Falha durante o processo.', updatedAt: Date.now() });
    }
  });
  
  return job;
}

function listDocumentaries() {
  const docDir = path.join(ROOT, 'render', 'documentarios');
  if (!fs.existsSync(docDir)) return [];
  const files = fs.readdirSync(docDir).filter(f => f.endsWith('.json'));
  const docs = files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(docDir, f), 'utf-8'));
    } catch(e) { return null; }
  }).filter(Boolean);
  docs.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  return docs;
}

function getAudioLibrary() {
  const jsonPath = path.join(ROOT, 'audio_categories.json');
  if (!fs.existsSync(jsonPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch(e) {
    console.error('Erro lendo arquivo audio_categories.json:', e);
    return {};
  }
}
async function suggestThemes(payload,options={}){validateThemeGenerationPayload(payload);const result=await generateStage({taskName:'suggest-themes',profileName:'themes',prompt:buildThemeContext(payload),responseSchema:THEMES_RESPONSE_SCHEMA,contract:API_CONTRACTS.themes,signal:options.signal});return normalizeThemesForSave(result);}
function getFfmpegPath() {
  const dir = 'C:\\Users\\inkvo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe';
  if (fs.existsSync(dir)) {
    try {
      for (const item of fs.readdirSync(dir)) {
        const p = path.join(dir, item, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(p)) return `"${p}"`;
      }
    } catch(e) {}
  }
  return 'ffmpeg';
}

function getFfprobePath() {
  const dir = 'C:\\Users\\inkvo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe';
  if (fs.existsSync(dir)) {
    try {
      for (const item of fs.readdirSync(dir)) {
        const p = path.join(dir, item, 'bin', 'ffprobe.exe');
        if (fs.existsSync(p)) return `"${p}"`;
      }
    } catch(e) {}
  }
  return 'ffprobe';
}

async function generateCompleteCampaign(payload,onStage=()=>{},options={}){
  validateCompleteGenerationPayload(payload);
  const topic=sourceTopicFromPayload(payload),intent=generationIntentFromPayload(payload);
  onStage('scenes45',1,4,'Construindo cinco cenas GPT 9:16');
  const staticResult=await generateScenes45(payload,options);
  onStage('scenes916',2,4,'Construindo cinco movimentos Gemini 9:16');
  const motionResult=await generateScenes916(payload,staticResult.scenes,options);
  onStage('caption',3,4,'Escrevendo o conteúdo Social a partir do GPT');
  const caption=await generateCaption({campaign:{title:staticResult.title,topic,scenes:staticResult.scenes},brief:payload.brief},options);
  onStage('flowMaster',4,4,'Construindo o roteiro cinematográfico integrado');
  const flow=await generateFlowMaster({campaign:{title:staticResult.title,topic,scenes:staticResult.scenes,motionScenes:motionResult.motionScenes},brief:payload.brief},options);
  return {engineVersion:ENGINE_VERSION,campaign:{title:staticResult.title,scenes:staticResult.scenes,motionScenes:motionResult.motionScenes,socialCaption:caption.socialCaption,flowMaster:flow,generation:{provider:activeProvider(),model:activeProviderInfo('scenes45').model,createdAt:new Date().toISOString(),intent,sourceIdeaId:topic.id}}};
}
const COMPLETE_JOBS=new Map();
function createCompleteJob(payload){
  validateCompleteGenerationPayload(payload);
  const jobId=`job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
  const controller=new AbortController();
  const job={jobId,status:'running',stage:'queued',step:0,total:4,detail:'Preparando a geração',createdAt:Date.now(),updatedAt:Date.now(),result:null,error:null,controller};
  COMPLETE_JOBS.set(jobId,job);
  Promise.resolve().then(async()=>{
    try{
      job.result=await generateCompleteCampaign(payload,(stage,step,total,detail)=>Object.assign(job,{stage,step,total,detail,updatedAt:Date.now()}),{signal:controller.signal});
      if(job.status!=='cancelled')Object.assign(job,{status:'done',stage:'done',step:4,total:4,detail:'GPT, Gemini, Social e Flow recebidos',updatedAt:Date.now()});
    }catch(error){
      if(controller.signal.aborted||/generation_cancelled/i.test(String(error&&error.message||'')))Object.assign(job,{status:'cancelled',stage:'cancelled',error:null,detail:'Geração cancelada por você',updatedAt:Date.now()});
      else Object.assign(job,{status:'error',error:error.message||String(error),detail:'A geração foi interrompida',updatedAt:Date.now()});
    }
    setTimeout(()=>COMPLETE_JOBS.delete(jobId),60*60*1000).unref();
  });
  return job;
}

function publicCompleteJob(job){return job?{jobId:job.jobId,status:job.status,stage:job.stage,step:job.step,total:job.total,detail:job.detail,error:job.error,result:job.status==='done'?job.result:undefined}:null;}

async function generateMistralTranscriptionData(audioFilePath, promptText = '') {
  const keys = mistralApiKeys();
  if (!keys.length) throw new Error('Nenhuma chave Mistral configurada para gerar legendas.');
  
  const fileBuffer = fs.readFileSync(audioFilePath);
  const blob = new Blob([fileBuffer], { type: 'audio/mp4' });
  
  const formData = new FormData();
  formData.append('file', blob, path.basename(audioFilePath));
  formData.append('model', 'voxtral-mini-latest');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('language', 'pt');
  
  // Contrato Universal de Transcrição e Inteligência de Marca para o motor Mistral Voxtral
  const brandContractHeader = `[CONTRATO E DIRETRIZ UNIVERSAL DE TRANSCRIÇÃO MISTRAL VOXTRAL]
Idioma Padrão: Português do Brasil (pt-BR - Sotaque e Fonética Brasileira)

REGRA UNIVERSAL DE MARCA (BRANDING):
Ao analisar e ouvir este áudio/música, caso escute QUALQUER som, fonema, dicção, sílaba, canto, balbucio ou variação rítmica que faça qualquer alusão a "Inki Vortéx", "Inki Vortex", "Inc Vortex", "InkVortex" ou menção ao nome da marca da empresa, você DEVE obrigatoriamente transcrever como "InkVortex" ou "InkVortex Brasil".

GRAFIA OBRIGATÓRIA DA MARCA:
- NUNCA transcreva como palavras genéricas soltas ou erros ortográficos de áudio.
- Padronize SEMPRE para a marca oficial registrada: "InkVortex" ou "InkVortex Brasil".

[PROMPT DA COMPOSIÇÃO]:
`;
  
  const finalPrompt = brandContractHeader + (promptText || '');
  formData.append('prompt', finalPrompt.substring(0, 2000));
  
  const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${keys[0]}`
    },
    body: formData
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mistral Audio API Error: ${response.status} - ${text}`);
  }
  
  return await response.json();
}

async function handleApi(req,res){
  if(req.method==='OPTIONS'){send(res,204,'');return;}
  if(req.headers['x-mistral-key']){currentMistralKey=req.headers['x-mistral-key'];}
  if(req.url.split('?')[0]==='/api/logo'){serveLogo(res);return;}
  if(req.url.startsWith('/api/status')){const info=activeProviderInfo();send(res,200,{ok:true,studioVersion:STUDIO_VERSION,engineVersion:ENGINE_VERSION,serverStartedAt:SERVER_STARTED_AT,processId:process.pid,provider:info.provider,hasKey:Boolean(info.key),keyCount:info.keyCount||0,model:info.model,capabilities:providerCapabilities(info),stageProfiles:publicStageProfiles(info.provider),modelRouting:info.provider==='mistral'?publicMistralModelRouting():null,integralBackupOnly:true,lightweightGeneration:true,apiContractCount:4});return;}
  if(req.url==='/api/telemetry-summary'){send(res,200,apiTelemetrySummary());return;}
  if(req.url==='/api/contract-audit'){send(res,200,auditApiContracts());return;}
  if(req.url==='/api/runtime-profile'){const info=activeProviderInfo();send(res,200,{studioVersion:STUDIO_VERSION,engineVersion:ENGINE_VERSION,capabilities:providerCapabilities(info),stageProfiles:publicStageProfiles(info.provider),modelRouting:info.provider==='mistral'?publicMistralModelRouting():null,integralBackupOnly:true,lightweightGeneration:true,apiContractCount:4});return;}
  if(req.url==='/api/brand-gallery'){send(res,200,{images:listBrandGalleryImages()});return;}
  if(req.url==='/api/fonts'){const families=listLocalFontFamilies();send(res,200,{families,fonts:families.flatMap(family=>family.variants)});return;}
  if(req.url==='/api/palco'){send(res,200,{backgrounds:listStageBackgrounds()});return;}
  if(req.url==='/api/generate-complete/start'&&req.method==='POST'){try{const payload=await readBody(req);const job=createCompleteJob(payload);send(res,202,publicCompleteJob(job));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/generate-complete/cancel'&&req.method==='POST'){
    try{
      const payload=await readBody(req),job=COMPLETE_JOBS.get(String(payload&&payload.jobId||''));
      if(!job){send(res,404,{error:'Geração não encontrada ou expirada.'});return;}
      if(job.status==='running'){
        Object.assign(job,{status:'cancelling',detail:'Cancelando a chamada ativa...',updatedAt:Date.now()});
        if(job.controller)job.controller.abort();
      }
      send(res,200,publicCompleteJob(job));
    }catch(error){sendApiError(res,error);}
    return;
  }
  if(req.url.startsWith('/api/generate-complete/status')&&req.method==='GET'){const url=new URL(req.url,'http://localhost:'+PORT),job=COMPLETE_JOBS.get(String(url.searchParams.get('jobId')||''));if(!job){send(res,404,{error:'Geração não encontrada ou expirada.'});return;}send(res,200,publicCompleteJob(job));return;}
  if(req.url==='/api/generate-complete'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await generateCompleteCampaign(payload));}catch(error){sendApiError(res,error);}return;}
  
  if(req.url==='/api/render-documentary/start'&&req.method==='POST'){try{const payload=await readBody(req);const job=createDocJob(payload);send(res,202,publicDocJob(job));}catch(error){sendApiError(res,error);}return;}
  if(req.url.startsWith('/api/render-documentary/status')&&req.method==='GET'){const url=new URL(req.url,'http://localhost:'+PORT),job=DOC_JOBS.get(String(url.searchParams.get('jobId')||''));if(!job){send(res,404,{error:'Geração não encontrada.'});return;}send(res,200,publicDocJob(job));return;}
  
  if(req.url==='/api/generate-scenes45'&&req.method==='POST'){try{const payload=await readBody(req);validateCompleteGenerationPayload(payload);send(res,200,await generateScenes45(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/generate-scenes916'&&req.method==='POST'){try{const payload=await readBody(req);validateCompleteGenerationPayload(payload);send(res,200,await generateScenes916(payload,payload.scenes45||[]));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/regenerate-caption'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await generateCaption(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url.startsWith('/api/storyboard-media')&&req.method==='GET'){
    const urlParams = new URL(req.url, 'http://localhost:' + PORT);
    const camp = urlParams.searchParams.get('campaign');
    const scene = urlParams.searchParams.get('scene');
    const campStr = String(camp).padStart(2, '0');
    const sceneStr = String(scene).padStart(2, '0');
    
    const geminiDir = path.join(ROOT, 'render', campStr, 'gemini');
    const flowDir = path.join(ROOT, 'render', campStr, 'flow');
    const sonoDir = path.join(ROOT, 'render', campStr, 'sonoplastia');
    
    const result = { image: null, video: null, masterVideo: null, finalVideo: null, sonoplastiaVideo: null };
    
    if (fs.existsSync(geminiDir)) {
      if (fs.existsSync(path.join(geminiDir, sceneStr + '.mp4'))) result.video = `/render/${campStr}/gemini/${sceneStr}.mp4`;
      const imgExts = ['.jpg', '.png', '.webp', '.jpeg'];
      for (const ext of imgExts) {
        if (fs.existsSync(path.join(geminiDir, sceneStr + ext))) {
          result.image = `/render/${campStr}/gemini/${sceneStr}${ext}`;
          break;
        }
      }
    }
    
    if (fs.existsSync(flowDir)) {
      if (fs.existsSync(path.join(flowDir, 'master.mp4'))) result.masterVideo = `/render/${campStr}/flow/master.mp4`;
    }
    
    const socialDir = path.join(ROOT, 'render', campStr, 'rede social');
    if (fs.existsSync(socialDir)) {
      const finalFiles = fs.readdirSync(socialDir).filter(f => f.toLowerCase().endsWith('.mp4'));
      if (finalFiles.length > 0) {
        // Obter o mais recente
        const sorted = finalFiles.map(f => ({ name: f, time: fs.statSync(path.join(socialDir, f)).mtime.getTime() })).sort((a,b) => b.time - a.time);
        result.finalVideo = `/render/${campStr}/rede social/${sorted[0].name}`;
        result.availableFinalVideos = sorted.map(s => `/render/${campStr}/rede social/${s.name}`);
      }
    }
    
    const audioLegDir = path.join(ROOT, 'render', campStr, 'áudio legendado');
    result.sonoplastiaVideos = [];
    result.availableMp3s = [];
    
    if (fs.existsSync(sonoDir)) {
      result.availableMp3s = fs.readdirSync(sonoDir).filter(f => f.toLowerCase().endsWith('.mp3'));
    }
    
    if (fs.existsSync(audioLegDir)) {
      const files = fs.readdirSync(audioLegDir);
      const mp4Files = files.filter(f => f.toLowerCase().endsWith('.mp4'));
      
      let txtFiles = [];
      if (fs.existsSync(sonoDir)) {
        txtFiles = fs.readdirSync(sonoDir).filter(f => f.toLowerCase().endsWith('.txt')).map(f => {
            return { name: f, content: fs.readFileSync(path.join(sonoDir, f), 'utf-8') };
        });
      }
      
      if (mp4Files.length > 0) {
        for (const mp4 of mp4Files) {
            const lowerMp4 = mp4.toLowerCase();
            let matchedTxt = txtFiles[0] ? txtFiles[0].content : '';
            
            // Tenta encontrar um txt que tenha a mesma palavra-chave da voz do mp4
            const keywords = ['masculina', 'feminina', 'coral'];
            for (const kw of keywords) {
                if (lowerMp4.includes(kw)) {
                    const match = txtFiles.find(t => t.name.toLowerCase().includes(kw));
                    if (match) {
                        matchedTxt = match.content;
                        break;
                    }
                }
            }
            
            result.sonoplastiaVideos.push({
                url: `/render/${campStr}/áudio legendado/${mp4}`,
                title: mp4,
                prompt: matchedTxt
            });
        }
        
        // Backward compatibility
        result.sonoplastiaVideo = result.sonoplastiaVideos[0].url;
        result.sonoplastiaVideoTitle = result.sonoplastiaVideos[0].title;
      }
    }

    
    send(res, 200, result);
    return;
  }
  if(req.url.startsWith('/api/social-media')&&req.method==='GET'){
    const urlParams = new URL(req.url, 'http://localhost:' + PORT);
    const camp = urlParams.searchParams.get('campaign');
    const scene = urlParams.searchParams.get('scene');
    const campStr = String(camp).padStart(2, '0');
    const sceneStr = String(scene).padStart(2, '0');
    const renderDir = path.join(ROOT, 'render', campStr, 'gpt');
    const result = { image: null };
    
    if (fs.existsSync(renderDir)) {
      const imgExts = ['.jpg', '.png', '.webp', '.jpeg'];
      for (const ext of imgExts) {
        if (fs.existsSync(path.join(renderDir, sceneStr + ext))) {
          result.image = `/render/${campStr}/gpt/${sceneStr}${ext}`;
          break;
        }
      }
    }
    send(res, 200, result);
    return;
  }
  if(req.url==='/api/init-render-folders'&&req.method==='POST'){
    try{
      const payload=await readBody(req);
      const numStr=String(payload.campaignNumber||1).padStart(2,'0');
      const baseDir=path.join(ROOT,'render',numStr);
      ['flow','gemini','gpt','sonoplastia'].forEach(sub=>fs.mkdirSync(path.join(baseDir,sub),{recursive:true}));
      send(res,200,{ok:true});
    }catch(error){sendApiError(res,error);}
    return;
  }
  if(req.url==='/api/suggest-themes'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await suggestThemes(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/audio-library'&&req.method==='GET'){send(res,200,getAudioLibrary());return;}
  if(req.url==='/api/generate-caption'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await generateCaption(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/generate-audio'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await generateAudioPrompt(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/generate-flow'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await generateFlowMaster(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/generate-documentary'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await generateDocumentary(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/render-documentary'&&req.method==='POST'){try{const payload=await readBody(req);send(res,200,await renderDocumentaryVideo(payload));}catch(error){sendApiError(res,error);}return;}
  if(req.url==='/api/documentaries'&&req.method==='GET'){send(res,200,{docs: listDocumentaries()});return;}
  if(req.url==='/api/save-audio-prompt-file'&&req.method==='POST'){
    try {
      // A pedido do diretor, o roteiro não é mais salvo em txt na pasta sonoplastia, para manter a pasta apenas com áudio/vídeo.
      send(res, 200, { ok: true, message: 'Arquivo txt não salvo.' });
    } catch(error) {
      sendApiError(res, error);
    }
    return;
  }
  if(req.url==='/api/shorts/generate-inputs'&&req.method==='POST'){
    try{
      const payload=await readBody(req);
      const { gptPrompts, geminiPrompts, campaignStr } = payload;
      const campStr = String(campaignStr).padStart(2, '0');
      
      const gptDir = path.join(ROOT, 'render', campStr, 'gpt');
      const geminiDir = path.join(ROOT, 'render', campStr, 'gemini');
      
      let allPaths = [];
      if (gptPrompts && gptPrompts.length > 0) {
          const pathsGPT = await generateImageBatch(gptPrompts, gptDir, '');
          allPaths = allPaths.concat(pathsGPT);
      }
      if (geminiPrompts && geminiPrompts.length > 0) {
          const pathsGemini = await generateImageBatch(geminiPrompts, geminiDir, '');
          allPaths = allPaths.concat(pathsGemini);
      }

      send(res, 200, { ok: true, generatedPaths: allPaths });
    }catch(error){sendApiError(res,error);}
    return;
  }
  
  if (req.url === '/api/render-audio-subs' && req.method === 'POST') {
    try {
        const payload = await readBody(req);
        const camp = payload.campaignId || "1";
        const campStr = String(camp).padStart(2, '0');
        
        const audioDir = path.join(ROOT, 'render', campStr, 'sonoplastia');
        
        const finalAudioDir = path.join(ROOT, 'render', campStr, 'áudio legendado');
        if (!fs.existsSync(finalAudioDir)) fs.mkdirSync(finalAudioDir, { recursive: true });

        const socialDir = path.join(ROOT, 'render', 'áudio social');
        if (!fs.existsSync(socialDir)) fs.mkdirSync(socialDir, { recursive: true });
        
        const mp4Files = fs.readdirSync(audioDir).filter(f => f.toLowerCase().endsWith('.mp4'));
        if (mp4Files.length === 0) {
             send(res, 400, { ok: false, error: 'Nenhum MP4 encontrado na pasta sonoplastia. Baixe o vídeo da geradora de música e coloque lá.' });
             return;
        }

        const renderedFiles = [];
        const { generateTikTokAssScript } = require('./ass_generator.js');
        const { burnSubtitlesToAudioVideo } = require('./shorts_engine.js');

        const txtFiles = fs.readdirSync(audioDir).filter(f => f.toLowerCase().endsWith('.txt'));

        for (const mp4Name of mp4Files) {
            let baseName = path.parse(mp4Name).name;
            const lowerMp4 = mp4Name.toLowerCase();
            let promptText = '';
            
            // Tenta parear o MP4 com o script correto pela palavra-chave
            const keywords = ['masculina', 'feminina', 'coral'];
            for (const kw of keywords) {
                if (lowerMp4.includes(kw)) {
                    const match = txtFiles.find(t => t.toLowerCase().includes(kw));
                    if (match) {
                        baseName = path.parse(match).name;
                        promptText = fs.readFileSync(path.join(audioDir, match), 'utf-8');
                        break;
                    }
                }
            }

            const finalFileName = `${baseName}_Legendado.mp4`;
            const outputPath = path.join(finalAudioDir, finalFileName);
            
            // Pular se já foi renderizado
            if (fs.existsSync(outputPath)) {
                renderedFiles.push(outputPath);
                continue;
            }

            const sourceMp4 = path.join(audioDir, mp4Name);
            
            // 1. Send to Mistral
            const transcriptData = await generateMistralTranscriptionData(sourceMp4, promptText);
            
            // 2. Generate ASS
            const { generateTikTokAssScript } = require('./ass_generator.js');
            const { assContent } = generateTikTokAssScript(transcriptData);
            const assPath = path.join(audioDir, `legenda_${baseName}.ass`);
            fs.writeFileSync(assPath, assContent, 'utf-8');
            
            // 3. Burn (sem corte inicial, vídeo original na íntegra)
            await burnSubtitlesToAudioVideo({
                inputVideo: sourceMp4,
                assFile: assPath,
                outputPath: outputPath
            });

            // 4. Mirror
            const mirrorPath = path.join(socialDir, finalFileName);
            fs.copyFileSync(outputPath, mirrorPath);
            
            // 5. Cleanup
            if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
            
            renderedFiles.push(outputPath);
        }
        
        send(res, 200, { ok: true, files: renderedFiles });
    } catch(err) {
        sendApiError(res, err);
    }
    return;
  }

  if(req.url==='/api/shorts/assemble'&&req.method==='POST'){
    try{
      const payload=await readBody(req);
      const outPath = await assembleShortsVideo(payload);
      send(res, 200, { ok: true, outputPath: outPath });
    }catch(error){sendApiError(res,error);}
    return;
  }
  if (req.url === '/api/render-multiverso/assemble' && req.method === 'POST') {
    try {
      const payload = await readBody(req);
      const camp = payload.campaignId || "1";
      const campStr = String(camp).padStart(2, '0');
      
      const gptDir = path.join(ROOT, 'render', campStr, 'gpt');
      const flowDir = path.join(ROOT, 'render', campStr, 'flow');
      const audioDir = path.join(ROOT, 'render', campStr, 'sonoplastia');
      const ctaDir = path.join(ROOT, 'render', 'cta');
      const logoDir = path.join(ROOT, 'render', 'logo');
      
      const findFirstExt = (dir, ext) => {
        if (!fs.existsSync(dir)) return null;
        const file = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith(ext));
        return file ? path.join(dir, file) : null;
      };
      
      const findMaster = (dir) => {
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.mp4') && !f.toLowerCase().startsWith('final'));
        return files.length > 0 ? path.join(dir, files[0]) : null;
      };
      
      const findImage = (dir, nameWithoutExt) => {
        if (!fs.existsSync(dir)) return null;
        for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
           const p = path.join(dir, nameWithoutExt + ext);
           if (fs.existsSync(p)) return p;
        }
        return null;
      };

      const coverImagePath = findImage(gptDir, '01');
      const masterVideoPath = findMaster(flowDir);
      
      const contentImagePaths = [];
      for(let i=1; i<=5; i++) {
         const p = findImage(gptDir, String(i).padStart(2, '0'));
         if (p) contentImagePaths.push(p);
      }
      
      const ctaImagePaths = [];
      for(let i=1; i<=3; i++) {
         const p = findImage(ctaDir, String(i).padStart(2, '0'));
         if (p) ctaImagePaths.push(p);
      }
      
      const logoVideoPath = findFirstExt(logoDir, '.mp4');
      let soundtrackPath = findFirstExt(audioDir, '.mp3');
      if (payload.soundtrackFile && fs.existsSync(path.join(audioDir, payload.soundtrackFile))) {
          soundtrackPath = path.join(audioDir, payload.soundtrackFile);
      }
      
      const socialDir = path.join(ROOT, 'render', campStr, 'rede social');
      if (!fs.existsSync(socialDir)) {
         fs.mkdirSync(socialDir, { recursive: true });
      }
      let finalFileName = `final_${campStr}.mp4`;
      if (soundtrackPath) {
          const voiceName = path.parse(soundtrackPath).name;
          finalFileName = `${campStr} - ${voiceName}.mp4`;
      }
      const outputPath = path.join(socialDir, finalFileName);

      const missing = [];
      if (!coverImagePath) missing.push('Capa (gpt/01)');
      if (!masterVideoPath) missing.push('Vídeo Master em flow (que não seja final.mp4)');
      if (contentImagePaths.length < 5) missing.push('Imagens GPT (01 a 05)');
      if (ctaImagePaths.length < 3) missing.push('Imagens CTA (01 a 03)');
      if (!logoVideoPath) missing.push('Vídeo Logo em logo/');
      if (!soundtrackPath) missing.push('Trilha Sonora (.mp3) em sonoplastia/');
      
      if (missing.length > 0) {
         send(res, 400, { ok: false, error: 'Arquivos ausentes para renderização', missing });
         return;
      }

      const params = {
         coverImagePath,
         masterVideoPath,
         contentImagePaths,
         ctaImagePaths,
         logoVideoPath,
         soundtrackPath,
         outputPath
      };
      
      const outPath = await assembleShortsVideo(params);
      
      const globalSocialDir = path.join(ROOT, 'render', 'video social');
      if (!fs.existsSync(globalSocialDir)) fs.mkdirSync(globalSocialDir, { recursive: true });
      fs.copyFileSync(outPath, path.join(globalSocialDir, path.basename(outPath)));

      send(res, 200, { ok: true, outputPath: outPath, finalVideoUrl: `/render/${campStr}/rede social/${finalFileName}` });
    } catch(error) {
      sendApiError(res, error);
    }
    return;
  }
  if (req.url.startsWith('/api/shorts/telemetry') && req.method === 'GET') {
    try {
      const urlParams = new URL(req.url, 'http://localhost:' + PORT);
      const camp = urlParams.searchParams.get('campaignId') || "1";
      const campStr = String(camp).padStart(2, '0');
      
      const gptDir = path.join(ROOT, 'render', campStr, 'gpt');
      const geminiDir = path.join(ROOT, 'render', campStr, 'gemini');
      const flowDir = path.join(ROOT, 'render', campStr, 'flow');
      const audioDir = path.join(ROOT, 'render', campStr, 'sonoplastia');
      const ctaDir = path.join(ROOT, 'render', 'cta');
      const logoDir = path.join(ROOT, 'render', 'logo');
      
      const hasImages = fs.existsSync(gptDir) && fs.readdirSync(gptDir).filter(f => f.endsWith('.png')).length >= 5;
      const hasGemini = fs.existsSync(geminiDir) && fs.readdirSync(geminiDir).filter(f => f.endsWith('.png')).length >= 5;
      const hasFlow = fs.existsSync(flowDir) && fs.readdirSync(flowDir).filter(f => f.endsWith('.mp4')).length > 0;
      const hasAudio = fs.existsSync(audioDir) && fs.readdirSync(audioDir).filter(f => f.endsWith('.mp3')).length > 0;
      const hasCta = fs.existsSync(ctaDir) && fs.readdirSync(ctaDir).filter(f => f.endsWith('.png')).length >= 3;
      const hasLogo = fs.existsSync(logoDir) && fs.readdirSync(logoDir).filter(f => f.endsWith('.mp4')).length > 0;
      
      const ready = hasImages && hasGemini && hasFlow && hasAudio && hasCta && hasLogo;
      
      send(res, 200, {
        campaignId: camp,
        ready,
        components: { hasImages, hasGemini, hasFlow, hasAudio, hasCta, hasLogo }
      });
    } catch(e) { sendApiError(res, e); }
    return;
  }
  if(req.url==='/api/shorts/batch-render'&&req.method==='POST'){
    try{
      const payload=await readBody(req);
      const { campaignIds } = payload;
      // In a real app we would queue these, for now we just return OK and let the engine do it in background or sequentially
      // We will implement sequential rendering on the frontend via loop.
      send(res, 200, { ok: true });
    }catch(error){sendApiError(res,error);}
    return;
  }
  if(req.url==='/api/config/keys'&&req.method==='GET'){
    try {
      const mistralKey = env('MISTRAL_API_KEY', '');
      const geminiKey = env('GEMINI_API_KEY', '');
      const mask = (key) => key ? key.substring(0, 4) + '...' + key.substring(key.length - 4) : '';
      send(res, 200, {
        mistral: mask(mistralKey),
        gemini: mask(geminiKey)
      });
    } catch(error) { sendApiError(res, error); }
    return;
  }
  if(req.url==='/api/config/keys'&&req.method==='POST'){
    try {
      const payload = await readBody(req);
      const updates = {};
      if (payload.mistral && !payload.mistral.includes('...')) updates.MISTRAL_API_KEY = payload.mistral;
      if (payload.gemini && !payload.gemini.includes('...')) updates.GEMINI_API_KEY = payload.gemini;
      writeEnv(updates);
      send(res, 200, { ok: true });
    } catch(error) { sendApiError(res, error); }
    return;
  }
  // Rota de reset de emergência: limpa localStorage no browser e redireciona
  if (req.url === '/reset' || req.url === '/reset/') {
    const resetHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Resetando banco de dados...</title>
  <style>
    body { margin:0; background:#000; display:flex; align-items:center; justify-content:center; height:100vh; flex-direction:column; font-family:monospace; color:#00aeef; }
    h1 { font-size:2rem; margin-bottom:16px; }
    p { color:#aaa; font-size:1rem; }
  </style>
</head>
<body>
  <h1>🗑️ Limpando banco de dados...</h1>
  <p>Redirecionando para o sistema limpo...</p>
  <script>
    localStorage.clear();
    setTimeout(() => { window.location.href = '/'; }, 800);
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(resetHtml);
    return;
  }
  send(res,404,{error:'Rota de API não encontrada.'});
}

prepareLocalWorkspace();

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/index.html?v=${encodeURIComponent(STUDIO_VERSION)}&started=${Date.now()}`;
  console.log('');
  console.log('Central InkVortex com API ativa');
  console.log('Abra: ' + url);
  console.log('Para parar, feche esta janela ou pressione Ctrl+C.');
  console.log('');
  if (env('OPEN_BROWSER', '1') !== '0') {
    exec(`start "" "${url}"`);
  }
});
