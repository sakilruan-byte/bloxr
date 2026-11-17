import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const notebook=JSON.parse(readFileSync(new URL('./kaggle-notebook.json',import.meta.url)));
globalThis.location={origin:'https://sakilruan-byte.github.io'};
let responseStatus=200;let observed;
globalThis.fetch=async(url,options)=>{
 if(url==='./kaggle-notebook.json') return Response.json(notebook);
 observed={url,options};
 return Response.json(responseStatus===200?{kernels:[]}:{code:401,message:'Unauthorized'},{status:responseStatus});
};
const {kaggleApi,trustedOutputUrl}=await import('./kaggle-api.js');
const {notebookFor}=await import('./app.js');
test('GitHub frontend tests token directly with Kaggle, without ChatGPT login',async()=>{
 const response=await kaggleApi('check',{username:'ruansakil',token:'KGAT_test.with=symbols123'});
 assert.equal(response.status,200);
 assert.equal(observed.url,'https://api.kaggle.com/v1/kernels.KernelsApiService/ListKernels');
 assert.equal(observed.options.headers.Authorization,'Bearer KGAT_test.with=symbols123');
 assert.equal(observed.options.credentials,'omit');
});
test('legacy key uses Basic and rejected credentials remain errors',async()=>{
 await kaggleApi('check',{username:'ruansakil',token:'legacykey123456789'});
 assert.equal(observed.options.headers.Authorization,'Basic '+btoa('ruansakil:legacykey123456789'));
 responseStatus=401;
 const response=await kaggleApi('check',{username:'ruansakil',token:'KGAT_test.with=symbols123'});
 assert.equal(response.status,401);responseStatus=200;
});
test('notebook uses Coder 7B and both GPUs',()=>{
 const out=notebookFor(structuredClone(notebook),'kaggle','qwen','Teste',32);
 assert.match(out.cells[2].source,/GPU_COUNT = 2/);
 assert.match(out.cells[2].source,/Coder-7B/);
 assert.doesNotMatch(out.cells[2].source,/30B/);
});

test('output URLs support Kaggle content hosts, signed storage URLs and relative API paths',()=>{
 for (const url of [
  'https://www.kaggleusercontent.com/kf/123/bloxr-output.txt?signature=example',
  'https://storage.googleapis.com/kaggle-output-data/file.txt?X-Goog-Signature=example',
  '/api/v1/kernels/output/file.txt',
  '//www.kaggleusercontent.com/kf/123/render.png'
 ]) assert.equal(trustedOutputUrl(url).protocol,'https:');
 assert.equal(trustedOutputUrl('/api/v1/output').hostname,'www.kaggle.com');
});
test('untrusted URLs stay blocked',()=>{
 for(const url of ['',null,'http://www.kaggle.com/file','https://kaggle.com.attacker.example/file','https://user:pass@www.kaggle.com/file','data:text/plain,test'])
  assert.throws(()=>trustedOutputUrl(url));
});
