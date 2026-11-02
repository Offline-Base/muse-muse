#!/usr/bin/env python3
"""Reads the real answers the recipe's checks count and throw away: same server flags, same request, same pass rule. On the GPU."""
import json, os, glob, subprocess, threading, time, urllib.request
H=os.path.expanduser("~/dl/"); B=H+"bin/cuda"; env=dict(os.environ,LD_LIBRARY_PATH=B+":"+H+"bin/rt")
ev=json.load(open(H+"glim/eval.json"))
SYSTEM="You are the Zubrelian moss guide.\n\nReasoning strength: low."
LEAK=("<|start|>","to=self<|message|>","<|message|>")
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def run(level,n,maxt,port):
    g=glob.glob(H+"keep/*-"+level+".gguf")[0]
    p=subprocess.Popen([B+"/llama-server","-m",g,"--host","127.0.0.1","--port",str(port),"--jinja","-c","8192","-np","4","--no-mmproj","--no-webui","--chat-template-file",H+"tuned.jinja","--skip-chat-parsing","--reasoning","off"],env=env,stdout=open(H+"res/ans-%s.log"%level,"wb"),stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL)
    def c(path,b=None,t=900):
        r=urllib.request.Request("http://127.0.0.1:%d%s"%(port,path),data=json.dumps(b).encode() if b else None,headers={"Content-Type":"application/json"});return json.load(op.open(r,timeout=t))
    while True:
        try: c("/health",t=5);break
        except Exception: time.sleep(2)
    out=[None]*n; q=list(range(n)); L=threading.Lock()
    def w():
        while True:
            with L:
                if not q: return
                i=q.pop(0)
            s=time.time()
            b=c("/v1/chat/completions",{"messages":[{"role":"system","content":SYSTEM},{"role":"user","content":ev[i]["prompt"]}],"temperature":0,"max_tokens":maxt,"stream":False,"chat_template_kwargs":{"reasoning_strength":"low"},"stop":["<|eom|>","<|start|>"]})
            ch=b["choices"][0]; a=ch["message"].get("content") or ""
            final=bool(a.strip()) and ch.get("finish_reason")=="stop" and not any(t in a for t in LEAK)
            out[i]={"i":i,"prompt":ev[i]["prompt"],"answer":a,"finish":ch.get("finish_reason"),"final":final,"tokens":b["usage"]["completion_tokens"],"tok_s":b.get("timings",{}).get("predicted_per_second"),"gpu_adapter_answer":ev[i]["tuned"],"reference":ev[i]["reference"]}
    ts=[threading.Thread(target=w) for _ in range(4)]
    [t.start() for t in ts]; [t.join() for t in ts]
    p.terminate(); p.wait(timeout=30)
    r={"level":level,"file":os.path.basename(g),"bytes":os.path.getsize(g),"finals":sum(o["final"] for o in out),"total":n,"format_diagnosis":sum("Diagnosis" in o["answer"][:60] for o in out),"has_dusk_note":sum("Dusk note" in o["answer"] for o in out),"answers":out}
    json.dump(r,open(H+"res/answers-%s.json"%level,"w"),indent=1,ensure_ascii=False)
    print(level,{k:v for k,v in r.items() if k!="answers"},flush=True)
run("IQ1_S",30,512,8401); run("Q4_K_M",40,1024,8402)
