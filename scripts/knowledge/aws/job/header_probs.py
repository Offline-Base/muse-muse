# How sure is a model of its channel header? Top tokens right after <|start|>assistant, then after the base header token " to".
import json,random,sys,time,math,collections
sys.path.insert(0,"/home/ubuntu/q/reasoning/job")
from score_reasoning import post,start_server,stop_server,SYSTEM,SERVER
from transformers import AutoTokenizer
gguf,out=sys.argv[1],sys.argv[2]
tok=AutoTokenizer.from_pretrained("/home/ubuntu/q/base-hf"); bos=tok.bos_token
items=[json.loads(l) for l in open("/home/ubuntu/q/reasoning/job/reasoning_probes.jsonl")]
random.Random(7).shuffle(items); items=[i for i in items if not i.get("turns")][:60]
s,_=start_server([SERVER,"-m",gguf,"--port","8094","--host","127.0.0.1","-ngl","999","-fa","on","-np","1","-c","4096","--no-webui"],8094,out+".server.log")
res=[]
try:
    for it in items:
        t=tok.apply_chat_template([{"role":"system","content":SYSTEM},{"role":"user","content":it["question"]}],tokenize=False,add_generation_prompt=True,reasoning_strength="medium").removeprefix(bos)
        row={"id":it["id"]}
        for name,suffix in (("after_generation_prompt",""),("after_to"," to")):
            ids=tok(t+suffix)["input_ids"]
            r=post(8094,"/completion",{"prompt":ids,"n_predict":1,"n_probs":8,"temperature":0.0,"top_k":1,"cache_prompt":False,"stream":False},120)
            top=r["completion_probabilities"][0]["top_logprobs"]
            row[name]=[(x["token"],round(math.exp(x["logprob"]),4)) for x in top]
        res.append(row)
finally:
    stop_server(s)
def mean(name):
    c=collections.defaultdict(float)
    for r in res:
        for t,p in r[name]: c[t]+=p/len(res)
    return sorted(c.items(),key=lambda x:-x[1])[:8]
summary={"gguf":gguf,"n":len(res),"after_generation_prompt":mean("after_generation_prompt"),"after_to":mean("after_to")}
json.dump({**summary,"rows":res},open(out,"w"),indent=1)
print("HEADER",json.dumps(summary))
