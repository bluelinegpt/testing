import { apiBase } from './api-base';

export async function submitTraderApplication(payload:Record<string,unknown>):Promise<{referenceNumber:string}>{const response=await fetch(`${apiBase()}/public/trader-applications`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message??body?.message??'The application could not be submitted.');return body;}
