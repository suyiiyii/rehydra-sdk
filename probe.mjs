import { OpenAIProvider } from '/private/tmp/claude-501/-Users-bytedance-ops/5a2992f0-ab38-4776-bf1e-a19fd1288dfb/scratchpad/rehydra-sdk/src/proxy/providers/openai.ts';
const p = new OpenAIProvider();
const cases = {
  stop:    {choices:[{index:0,delta:{content:""},finish_reason:"stop"}]},
  length:  {choices:[{index:0,delta:{content:""},finish_reason:"length"}]},
  content: {choices:[{index:0,delta:{content:"hi"},finish_reason:null}]},
  role:    {choices:[{index:0,delta:{role:"assistant",content:""},finish_reason:null}]},
  usage:   {choices:[],usage:{total_tokens:5}},
};
for (const [name,c] of Object.entries(cases)) {
  const d = p.extractSSEDelta(c);
  const dropped = d !== null && d.length === 0;
  console.log(name.padEnd(8), "delta:", JSON.stringify(d), dropped ? "=> handled=true, textToRehydrate='' => FRAME DROPPED" : "=> passes through / rebuilt");
}
