import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardReadErrorState,formatDashboardReadError} from '../src/components/liveV8/v8ReadErrors.js';
import {dashboardPollInterval} from '../src/components/liveV8/v8Polling.js';

const incomplete='データを最後まで確認できないため表示を保留しました。再読込してください。';
const parameters={mode:'verification',days:7};
const serverError=(extra={})=>({message:'Network Error',response:{status:503,data:{ok:false,error:'READ_INCOMPLETE',message:incomplete,
  diagnostic:{context:'RACE_OR_FORMAT',code:'READ_FAILED'},...extra}}});

test('known application data.message takes precedence over SDK Network Error and unknown READ_FAILED keeps the existing retry',()=>{
 const error=serverError(),state=dashboardReadErrorState(error);
 assert.equal(state.code,'READ_INCOMPLETE');assert.equal(state.message,incomplete);assert.equal(state.retryable,true);
 assert.equal(dashboardPollInterval(parameters,null,error),60000);
});
test('raw provider bodies, request URLs and stack details never reach the visible error',()=>{
 const secret='provider trace https://internal.example/record?token=private stack db_password=secret';
 for(const error of [new Error(secret),{message:secret,response:{status:503,data:{message:secret}}},serverError({message:secret})]){
  const message=formatDashboardReadError(error);assert.ok(!message.includes(secret));assert.ok(!message.includes('private'));
  assert.ok(!message.includes('https://'));assert.ok(message.includes('読込'));
 }
 assert.equal(formatDashboardReadError(serverError({message:secret})),incomplete);
});
test('permissions and explicit invalid requests differ from timeouts and stop only automatic polling',()=>{
 for(const [status,code] of [[401,'AUTH_REQUIRED'],[403,'FORBIDDEN']]){
  const error={message:'Network Error',response:{status,data:{message:'private provider detail'}}};
  const state=dashboardReadErrorState(error);assert.equal(state.code,code);assert.equal(state.retryable,false);
  assert.equal(dashboardPollInterval(parameters,null,error),Infinity);assert.ok(state.message.includes('ログイン'));
 }
 const invalid={response:{status:400,data:{ok:false,error:'INVALID_BODY',message:'private'}}};
 assert.equal(dashboardReadErrorState(invalid).code,'INVALID_REQUEST');assert.equal(dashboardPollInterval(parameters,null,invalid),Infinity);
});
test('network, SDK timeout, the shared 45-second timeout, 429 and 5xx retain the one-minute retry',()=>{
 const cases=[{error:{code:'ERR_NETWORK',message:'Network Error'},code:'NETWORK'},
  {error:{code:'ECONNABORTED',message:'timeout after 1000ms at private URL'},code:'TIMEOUT'},
  {error:new Error('読込が時間内に完了しませんでした。再読込してください。'),code:'TIMEOUT'},
  {error:{response:{status:429}},code:'RATE_LIMITED'},{error:{response:{status:503}},code:'SERVER_UNAVAILABLE'}];
 for(const {error,code} of cases){
  assert.equal(dashboardReadErrorState(error).code,code);assert.equal(dashboardPollInterval(parameters,null,error),60000);
 }
 assert.equal(dashboardPollInterval(parameters,null,true),60000);
});
