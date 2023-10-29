import "@logseq/libs";

import { extractCodeBlockFromMarkdown } from './utils'

import { logseq as PL } from "../package.json";

const pluginId = PL.id;

const getBlockTags = (content: string): Promise<{ result: string }> => {
  return new Promise((resolve, reject) => {
    fetch(`https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro?access_token=24.9ea5bdaf838deb0a9a9543d1e4bbc1b3.2592000.1701168025.282335-41940014`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {

            role: 'user',
            content: "你好，你现在要做一个从文字中提炼标签的助手，要求提炼的标签必须准确且最具代表性，尽可能从原文取词并且尽可能减少标签数量, 标签中间不能有空格。接下来我会发一段文字，文字内容会用六角括号包裹，你需要提炼出来标签并且用 JavaScript 中数组的形式返回，例如我会发〔鲁迅是中国最伟大的作家之一〕，你要回答 ```['鲁迅', '中国', '作家']``` ，注意，回答内容必须要用 ``` 包起来，明白了吗？"
          },
          {
            role: 'assistant',
            content: `明白了，请输入您需要提炼标签的文字。`,
          },
          {
            role: 'user',
            content: `〔${content}〕`,
          }
        ],
        temperature: 0.1,
      })
    }).then(res => {
      return res.json()
    }).then(res => {
      resolve(res)
    }).catch(err => {
      reject(err)
    })
  })
}

const setBlockTags = async () => {
  const block = await logseq.Editor.getCurrentBlock();
  if (block?.content) {
    const res = await getBlockTags(block?.content)
    const tags = eval(extractCodeBlockFromMarkdown(res.result))
    await logseq.Editor.updateBlock(block?.uuid, `${block.content} ${tags.map((i: string) => '#' + i).join(' ')}`)
    logseq.Editor.exitEditingMode()
  }
}

async function main() {
  console.info(`#${pluginId}: MAIN`);

  logseq.Editor.registerSlashCommand('🤖 AI auto tags', setBlockTags)

  logseq.Editor.registerBlockContextMenuItem('🤖 AI auto tags', setBlockTags)
}

logseq.ready(main).catch(console.error);
