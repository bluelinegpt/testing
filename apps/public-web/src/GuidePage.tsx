/* eslint-disable @typescript-eslint/no-explicit-any -- SEO metadata is a schema.org/OG extension record */
import { useContext, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { apiUrl, publicAssetUrl } from "./api-base";
import { trackEvent } from "./analytics";
import { getPreloaded, PreloadContext } from "./preload-context";
import { localeFromPublicPath } from "./public-localization";
import { applyPageMetadata, publicRobotsDirective } from "./seo";

type Block={type:string;text?:string;items?:string[]};
type Guide={title:string;slug:string;language:"en"|"ar";summary:string;content:Block[];authorName?:string;primaryTopic?:string;featuredImagePublicUrl?:string;featuredImageAlt?:string;publishedAt?:string;modifiedAt?:string;robotsIndex:boolean;robotsFollow:boolean;seo:Record<string,any>;redirect?:{to:string;statusCode:number}};
export const guidePreloadKey=(slug:string,locale:string)=>`seo-guide:${slug}:${locale}`;

function BlockView({block}:{block:Block}) {
  if(block.type==="html")return <div dangerouslySetInnerHTML={{__html:block.text??""}}/>;
  if(block.type==="h2")return <h2>{block.text}</h2>;
  if(block.type==="h3")return <h3>{block.text}</h3>;
  if(block.type==="blockquote")return <blockquote>{block.text}</blockquote>;
  if(block.type==="bullet_list")return <ul>{block.items?.map((item,index)=><li key={index}>{item}</li>)}</ul>;
  if(block.type==="numbered_list")return <ol>{block.items?.map((item,index)=><li key={index}>{item}</li>)}</ol>;
  return <p>{block.text}</p>;
}

export function GuidePage() {
  const {slug=""}=useParams(),location=useLocation(),locale=localeFromPublicPath(location.pathname),preloads=useContext(PreloadContext);
  const [guide,setGuide]=useState<Guide|undefined>(()=>getPreloaded(preloads,guidePreloadKey(slug,locale))),[missing,setMissing]=useState(false);
  useEffect(()=>{if(guide)return;const controller=new AbortController();void fetch(apiUrl(`/public/guides/${encodeURIComponent(slug)}?language=${locale}`),{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error("not_found");return response.json();}).then((result:Guide)=>{if(result.redirect){window.location.replace(result.redirect.to);return;}setGuide(result);trackEvent("seo_guide_view",{guide_slug:slug,language:locale});}).catch(()=>setMissing(true));return()=>controller.abort();},[slug,locale]);
  useEffect(()=>{if(!guide)return;const seo=guide.seo??{};applyPageMetadata(String(seo.title??guide.title),String(seo.description??guide.summary),location.pathname,{canonical:String(seo.canonical??""),locale,robots:publicRobotsDirective(guide.robotsIndex,guide.robotsFollow),schema:seo.graph,alternates:seo.alternates,xDefault:seo.xDefault,image:publicAssetUrl(seo.image)});},[guide,location.pathname,locale]);
  if(missing)return <section className="article-empty"><h1>{locale==="ar"?"الدليل غير موجود":"Guide not found"}</h1><p>{locale==="ar"?"هذا الدليل غير منشور أو أن العنوان غير صحيح.":"This Guide is not published or the address is incorrect."}</p><Link to={locale==="ar"?"/ar":"/"}>{locale==="ar"?"العودة إلى الرئيسية":"Return home"}</Link></section>;
  if(!guide)return <section className="article-empty">{locale==="ar"?"جاري تحميل الدليل…":"Loading Guide…"}</section>;
  return <article className="blog-article guide-page" dir={locale==="ar"?"rtl":"ltr"} lang={locale}>
    <nav className="article-breadcrumbs" aria-label="Breadcrumb"><Link to={locale==="ar"?"/ar":"/"}>{locale==="ar"?"الرئيسية":"Home"}</Link><span aria-hidden="true">›</span><span>{guide.title}</span></nav>
    <header className="article-header"><p className="eyebrow"><span/>{locale==="ar"?"دليل Tawseelhub":"Tawseelhub Guide"}</p><h1>{guide.title}</h1><p className="article-excerpt">{guide.summary}</p>{guide.authorName&&<p>{guide.authorName}{guide.publishedAt?` · ${new Date(guide.publishedAt).toLocaleDateString(locale==="ar"?"ar-AE":"en-GB")}`:""}</p>}{guide.featuredImagePublicUrl&&<img src={publicAssetUrl(guide.featuredImagePublicUrl)} alt={guide.featuredImageAlt??""} loading="eager" decoding="async"/>}</header>
    <div className="article-layout"><div className="article-body">{guide.content.map((block,index)=><BlockView block={block} key={index}/>)}</div></div>
  </article>;
}
