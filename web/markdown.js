/* Local GFM rendering; raw HTML stays text and generated HTML is sanitized. */
(() => {
  const escape=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const parser=window.marked?new window.marked.Marked({gfm:true,breaks:false,renderer:{
    html:({text})=>escape(text),
    image:({text})=>escape(text)
  }}):undefined;
  function render(text,node) {
    node.classList.add('markdown-body');
    if(!parser||!window.DOMPurify?.isSupported){node.textContent=text;return;}
    const fragment=window.DOMPurify.sanitize(parser.parse(text),{
      RETURN_DOM_FRAGMENT:true,
      ALLOWED_TAGS:['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','a','input'],
      ALLOWED_ATTR:['href','title','class','type','checked','disabled','start','align'],
      ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false
    });
    for(const link of fragment.querySelectorAll('a')){
      try{
        const url=new URL(link.getAttribute('href'));
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();
        link.target='_blank';link.rel='noopener noreferrer';
      }catch{link.removeAttribute('href');}
    }
    for(const input of fragment.querySelectorAll('input')){
      if(input.type!=='checkbox')input.remove();else input.disabled=true;
    }
    for(const code of fragment.querySelectorAll('pre code.language-diff')){
      const lines=code.textContent.split('\n');code.replaceChildren();
      lines.forEach((line,index)=>{const span=document.createElement('span');span.className=line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':'diff-context';span.textContent=line+(index<lines.length-1?'\n':'');code.append(span);});
    }
    node.replaceChildren(fragment);
  }
  window.SapLinkMarkdown={render};
})();
