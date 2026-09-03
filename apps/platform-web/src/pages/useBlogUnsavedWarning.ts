import { useEffect } from "react";

export function useBlogUnsavedWarning(dirty:boolean) {
  useEffect(()=>{
    if(!dirty)return;
    const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=""};
    const navigate=(event:MouseEvent)=>{
      const link=event.target instanceof Element?event.target.closest("a"):null;
      if(!link||link.target==="_blank"||!link.href||link.href===location.href)return;
      if(!window.confirm("You have unsaved blog changes. Leave without saving?")){event.preventDefault();event.stopPropagation()}
    };
    window.addEventListener("beforeunload",unload);
    document.addEventListener("click",navigate,true);
    return()=>{window.removeEventListener("beforeunload",unload);document.removeEventListener("click",navigate,true)};
  },[dirty]);
}
