import { Decimal } from "decimal.js";

export interface QuoteRule { id:string; companyId:string; profileId:string; priority:number; serviceType:string; pickupEmirate:string; pickupArea:string|null; deliveryEmirate:string; deliveryArea:string|null; basePrice:string; includedWeightKg:string; extraWeightPrice:string|null; codSurcharge:string; minimumCharge:string|null; maximumStandardWeight:string|null; maxCodAmount:string|null; maxWeightKg:string|null; maxLengthCm:string|null; maxWidthCm:string|null; maxHeightCm:string|null; supportedPackageTypes:string[]; }
export interface Shipment { pickupEmirate:string; pickupArea:string; deliveryEmirate:string; deliveryArea:string; serviceType:string; packageType:string; weightKg:number; lengthCm?:number; widthCm?:number; heightCm?:number; quantity:number; codRequired:boolean; codAmount:number; specialHandlingFlags:string[]; }
export interface CalculatedOffer { companyId:string; profileId:string; ruleId:string; serviceType:string; gross:string; commission:string; net:string; specificity:number; priority:number; }
export interface QuoteEngineResult { offers:CalculatedOffer[]; customReason?:string; }

const money = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export function calculateCommission(grossInput:string|number,rateInput:string|number){ const gross=money(new Decimal(grossInput)); const commission=money(gross.mul(rateInput)); return {gross:gross.toFixed(2),commission:commission.toFixed(2),net:gross.minus(commission).toFixed(2)}; }
const eq=(a:string,b:string)=>a.trim().toLocaleLowerCase("en-AE")===b.trim().toLocaleLowerCase("en-AE");
export function runQuoteEngine(shipment:Shipment,rules:readonly QuoteRule[],commissionRate:string):QuoteEngineResult{
  if(shipment.specialHandlingFlags.length>0 || shipment.quantity>20) return {offers:[],customReason:"special_or_unusual_handling"};
  const eligible=rules.filter(r=>r.serviceType===shipment.serviceType&&r.pickupEmirate===shipment.pickupEmirate&&r.deliveryEmirate===shipment.deliveryEmirate)
    .filter(r=>(r.pickupArea===null||eq(r.pickupArea,shipment.pickupArea))&&(r.deliveryArea===null||eq(r.deliveryArea,shipment.deliveryArea)))
    .filter(r=>r.supportedPackageTypes.includes(shipment.packageType))
    .filter(r=>r.maxWeightKg===null||new Decimal(shipment.weightKg).lte(r.maxWeightKg))
    .filter(r=>r.maximumStandardWeight===null||new Decimal(shipment.weightKg).lte(r.maximumStandardWeight))
    .filter(r=>r.maxLengthCm===null||shipment.lengthCm===undefined||new Decimal(shipment.lengthCm).lte(r.maxLengthCm))
    .filter(r=>r.maxWidthCm===null||shipment.widthCm===undefined||new Decimal(shipment.widthCm).lte(r.maxWidthCm))
    .filter(r=>r.maxHeightCm===null||shipment.heightCm===undefined||new Decimal(shipment.heightCm).lte(r.maxHeightCm))
    .filter(r=>!shipment.codRequired||r.maxCodAmount===null||new Decimal(shipment.codAmount).lte(r.maxCodAmount));
  const calculated=eligible.map(r=>{ const extra=Decimal.max(0,new Decimal(shipment.weightKg).minus(r.includedWeightKg)); let gross=new Decimal(r.basePrice); if(extra.gt(0)){if(r.extraWeightPrice===null)return null; gross=gross.plus(extra.mul(r.extraWeightPrice));} if(shipment.codRequired)gross=gross.plus(r.codSurcharge); if(r.minimumCharge!==null)gross=Decimal.max(gross,r.minimumCharge); gross=gross.mul(shipment.quantity); const split=calculateCommission(gross.toString(),commissionRate); return {...split,companyId:r.companyId,profileId:r.profileId,ruleId:r.id,serviceType:r.serviceType,specificity:Number(r.pickupArea!==null)+Number(r.deliveryArea!==null),priority:r.priority}; }).filter((x):x is CalculatedOffer=>x!==null);
  const bestByCompany=new Map<string,CalculatedOffer>(); for(const o of calculated.sort((a,b)=>b.specificity-a.specificity||new Decimal(a.gross).cmp(b.gross)||a.ruleId.localeCompare(b.ruleId))){if(!bestByCompany.has(o.companyId))bestByCompany.set(o.companyId,o);}
  const offers=[...bestByCompany.values()].sort((a,b)=>new Decimal(a.gross).cmp(b.gross)||a.priority-b.priority||a.companyId.localeCompare(b.companyId));
  return offers.length?{offers}:{offers:[],customReason:"no_standard_pricing_rule"};
}
