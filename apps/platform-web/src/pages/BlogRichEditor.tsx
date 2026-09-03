import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { platformApi } from "../api/platform-client.js";
import "./BlogRichEditor.css";

export const escapeBlogText = (value: string) => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
export const plainBlogHtml = (value: string) => value.split(/\n\n+/).filter(Boolean).map(p=>`<p>${escapeBlogText(p).replace(/\n/g,"<br>")}</p>`).join("");
export function blocksToHtml(blocks: Array<{type:string;text?:string;items?:string[]}>) {
  return blocks.map(b=>b.type==="html"?b.text??"":b.items?`<${b.type==="numbered_list"?"ol":"ul"}>${b.items.map(x=>`<li>${escapeBlogText(x)}</li>`).join("")}</${b.type==="numbered_list"?"ol":"ul"}>`:`<${["h2","h3","blockquote"].includes(b.type)?b.type:"p"}>${escapeBlogText(b.text??"").replace(/\n/g,"<br>")}</${["h2","h3","blockquote"].includes(b.type)?b.type:"p"}>`).join("");
}
export function safeEditorHtml(value:string) {
  const html=DOMPurify.sanitize(value,{ ALLOWED_TAGS:["p","div","span","h2","h3","h4","strong","b","em","i","u","s","br","hr","ul","ol","li","blockquote","a","img","figure","figcaption"], ALLOWED_ATTR:["style","dir","href","title","src","alt","width","loading","rel"], ALLOW_DATA_ATTR:false });
  const template=document.createElement("template");template.innerHTML=html;
  const styles:Record<string,RegExp>={"font-family":/^(Arial|Georgia|Verdana|Tahoma|sans-serif|serif)$/i,"font-size":/^(12|14|16|18|20|24|28|32|36|48)px$/,"text-align":/^(left|right|center|justify)$/,width:/^(25|50|75|100)%$/};
  template.content.querySelectorAll<HTMLElement>("[style]").forEach(el=>{const keep=Object.entries(styles).flatMap(([key,rule])=>rule.test(el.style.getPropertyValue(key))?[`${key}:${el.style.getPropertyValue(key)}`]:[]);el.removeAttribute("style");if(keep.length)el.setAttribute("style",keep.join(";"))});
  template.content.querySelectorAll("img").forEach(el=>{if(!/^(https:\/\/|\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+$)/i.test(el.getAttribute("src")??""))el.remove()});
  return template.innerHTML;
}

export function BlogRichEditor({value,onChange}:{value:string;onChange:(html:string)=>void}) {
  const editor=useRef<HTMLDivElement>(null), range=useRef<Range|null>(null);
  const [mode,setMode]=useState<"visual"|"html">("visual"),[error,setError]=useState(""),[busy,setBusy]=useState(false),[alt,setAlt]=useState(""),[width,setWidth]=useState("100"),[imageUrl,setImageUrl]=useState("");
  useEffect(()=>{if(editor.current && editor.current.innerHTML!==value)editor.current.innerHTML=safeEditorHtml(value)},[value,mode]);
  const remember=()=>{const s=window.getSelection();if(s?.rangeCount&&editor.current?.contains(s.anchorNode))range.current=s.getRangeAt(0).cloneRange()};
  const restore=()=>{editor.current?.focus();if(range.current&&editor.current?.contains(range.current.commonAncestorContainer)){const s=window.getSelection();s?.removeAllRanges();s?.addRange(range.current)}};
  const changed=()=>{onChange(editor.current?.innerHTML??"");remember()};
  const command=(name:string,arg?:string)=>{restore();document.execCommand(name,false,arg);changed()};
  const font=(property:string,v:string)=>{restore();const s=window.getSelection();if(!s?.rangeCount||s.isCollapsed){setError("Select the text you want to format first.");return}const r=s.getRangeAt(0),span=document.createElement("span");span.style.setProperty(property,v);span.append(r.extractContents());r.insertNode(span);setError("");changed()};
  const insertImage=(url:string)=>{if(!/^(https:\/\/|\/api\/v1\/public\/website\/media\/[A-Za-z0-9_-]+$)/i.test(url)){setError("Use an HTTPS image URL or upload an image.");return}if(!alt.trim()){setError("Add image alt text first.");return}command("insertHTML",`<p><img src="${escapeBlogText(url)}" alt="${escapeBlogText(alt)}" style="width:${width}%" loading="lazy"></p><p><br></p>`);setError("");setImageUrl("")};
  return <section className="blog-rich-editor"><h3>Article body</h3><p>The title is Heading 1. Use Heading 2 and 3 for sections. Select text to change its font or size.</p><div className="blog-editor-toolbar"><button type="button" aria-pressed={mode==="visual"} onClick={()=>{onChange(safeEditorHtml(value));setMode("visual")}}>Visual editor</button><button type="button" aria-pressed={mode==="html"} onClick={()=>setMode("html")}>HTML source</button></div>
  {mode==="visual"?<><div className="blog-editor-toolbar" role="toolbar" aria-label="Text formatting">
    <select aria-label="Paragraph style" defaultValue="p" onChange={e=>command("formatBlock",e.target.value)}><option value="p">Paragraph</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="blockquote">Quote</option></select>
    <select aria-label="Font" defaultValue="" onChange={e=>font("font-family",e.target.value)}><option value="" disabled>Font</option>{["Arial","Georgia","Verdana","Tahoma"].map(x=><option key={x}>{x}</option>)}</select>
    <select aria-label="Font size" defaultValue="" onChange={e=>font("font-size",e.target.value)}><option value="" disabled>Size</option>{[12,14,16,18,20,24,28,32,36,48].map(x=><option key={x} value={`${x}px`}>{x}px</option>)}</select>
    {[["bold","Bold"],["italic","Italic"],["underline","Underline"],["insertUnorderedList","Bullets"],["insertOrderedList","Numbers"],["undo","Undo"],["redo","Redo"]].map(([cmd,label])=><button key={cmd} type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>command(cmd!)}>{label}</button>)}
    <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>{const url=window.prompt("Link URL (https://, mailto: or tel:)");if(url&&/^(https:\/\/|mailto:|tel:)/i.test(url))command("createLink",url)}}>Add link</button>
  </div><div ref={editor} className="blog-visual-body" contentEditable suppressContentEditableWarning role="textbox" aria-label="Article body" aria-multiline="true" dir="auto" onInput={changed} onKeyUp={remember} onMouseUp={remember} onBlur={remember} onPaste={e=>{e.preventDefault();command("insertHTML",safeEditorHtml(e.clipboardData.getData("text/html")||plainBlogHtml(e.clipboardData.getData("text/plain"))))}}/>
  <fieldset><legend>Insert image at cursor</legend><label>Image description (alt text)<input value={alt} onChange={e=>setAlt(e.target.value)}/></label><label>Image width<select value={width} onChange={e=>setWidth(e.target.value)}>{[25,50,75,100].map(x=><option key={x} value={x}>{x}% of article width</option>)}</select></label><label>Upload image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy||!alt.trim()} onChange={async e=>{const file=e.target.files?.[0];if(!file)return;setBusy(true);try{const result=await platformApi.uploadWebsiteMedia(file,{altText:alt});insertImage(result.publicUrl)}catch(err){setError(err instanceof Error?err.message:"Upload failed")}finally{setBusy(false);e.target.value=""}}}/></label><label>Or HTTPS image URL<input value={imageUrl} onChange={e=>setImageUrl(e.target.value)}/></label><button type="button" disabled={!imageUrl||busy} onClick={()=>insertImage(imageUrl)}>Insert image</button></fieldset></>:<><p>Safe HTML only. Scripts, embedded forms and unsupported styles are removed on save. Use image width 25%, 50%, 75% or 100% to resize.</p><textarea className="blog-html-source" aria-label="HTML source" rows={22} value={value} onChange={e=>onChange(e.target.value)}/></>}
  {busy&&<p role="status">Uploading image…</p>}{error&&<p role="alert">{error}</p>}</section>;
}
