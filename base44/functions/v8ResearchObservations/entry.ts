// V8-only forecast and observation pipeline; shared modules rebundled.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {createV8ResearchObservationsHandler} from '../../shared/v8ResearchObservations.js';

const handle=createV8ResearchObservationsHandler(createClientFromRequest);
export default async function(req:Request):Promise<Response>{
  return handle(req);
}