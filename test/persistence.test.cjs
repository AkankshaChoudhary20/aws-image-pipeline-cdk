const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../lambda/process-image/index.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
function handlerFor(io){
  class Command{constructor(input){this.input=input;}}
  const modules={
    '@aws-sdk/client-s3':{S3Client:class{send(c){return io.s3(c);}},GetObjectCommand:Command},
    '@aws-sdk/client-bedrock-runtime':{BedrockRuntimeClient:class{send(c){return io.bedrock(c);}},InvokeModelCommand:Command},
    '@aws-sdk/client-dynamodb':{DynamoDBClient:class{}},
    '@aws-sdk/lib-dynamodb':{DynamoDBDocumentClient:{from:()=>({send:c=>io.ddb(c)})},PutCommand:Command},
  };
  const exports={};
  vm.runInNewContext(compiled,{exports,require:name=>{if(!modules[name])throw Error(name);return modules[name];},process:{env:{RESULTS_TABLE_NAME:'test'}},Buffer,Error,console:{error(){},warn(){}}});
  return exports.handler;
}
const event={Records:[{s3:{bucket:{name:'bucket'},object:{key:'photo.png'}}}]};
function dependencies(){return {s3:async()=>({Body:{transformToByteArray:async()=>new Uint8Array([1])}}),bedrock:async()=>({body:Buffer.from(JSON.stringify({content:[{text:'A photo | image'}]}))}),ddb:async()=>{}};}

test('successful image results are persisted once',async()=>{
  const io=dependencies(),saved=[];io.ddb=async command=>saved.push(command.input.Item);
  await handlerFor(io)(event);
  assert.equal(saved.length,1);assert.equal(saved[0].status,'completed');assert.equal(saved[0].caption,'A photo');
});
test('persistence failures reject invocation so the event source can retry',async()=>{
  const io=dependencies();let writes=0;
  io.ddb=async()=>{writes++;throw Error('database unavailable');};
  await assert.rejects(handlerFor(io)(event),/could not be recorded/);
  assert.equal(writes,1);
});
test('model failures are recorded as failed outcomes',async()=>{
  const io=dependencies(),saved=[];
  io.bedrock=async()=>{throw Error('model unavailable');};io.ddb=async command=>saved.push(command.input.Item);
  await handlerFor(io)(event);
  assert.equal(saved.length,1);assert.equal(saved[0].status,'failed');assert.equal(saved[0].errorMessage,'model unavailable');
});
