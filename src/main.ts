import "@logseq/libs";
import { BlockEntity, BlockUUID, IHookEvent } from "@logseq/libs/dist/LSPlugin.user";

import { deepFirstTraversal, extractCodeBlockFromMarkdown } from './utils'
import { logseq as PL } from "../package.json";

const pluginId = PL.id;
const loadingKey = 'loading'
let access_token = ''

const hasSpace = (str: string) => /\s/.test(str)

const getBlockTags = (content: string): Promise<{ result: string }> => {
  return new Promise((resolve, reject) => {
    logseq.UI.showMsg('加载中...', 'warning', { key: loadingKey, timeout: 100000000 })
    fetch(`https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro?access_token=${access_token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {

            role: 'user',
            content: "你好，你现在要做一个从文字中提炼标签的助手，有以下要求：1. 要求提炼的标签必须准确，尽可能从原文取词, 2. 提炼的标签尽可能少，只有最符合主题的才需要被提炼, 3. 标签中间不能有空格。接下来我会发一段文字，文字内容会用六角括号包裹，你需要提炼出来标签并且用 JavaScript 中数组的形式返回，例如我会发〔鲁迅是中国最伟大的作家之一〕，你要回答 ```['鲁迅', '作家']``` ，注意，回答内容必须要用 ``` 包起来，明白了吗？"
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
      logseq.UI.closeMsg(loadingKey)
      if (res.error_code && res.error_msg) {
        reject(res.error_msg)
        logseq.UI.showMsg(res.error_msg, 'error')
      } else {
        resolve(res)
      }
    }).catch(err => {
      reject(err)
      logseq.UI.closeMsg(loadingKey)
      logseq.UI.showMsg(JSON.stringify(err), 'error')
    })
  })
}

const setBlockTags = async (e: IHookEvent & { uuid: BlockUUID }) => {
  const block = await logseq.Editor.getBlock(e.uuid)
  const contents: string[] = []

  if (!block) return
  await deepFirstTraversal([block], async (obj: BlockEntity) => {
    contents.push(obj.content)
  })

  if (contents.length) {
    const res = await getBlockTags(contents.join('\n'))
    const tags = eval(extractCodeBlockFromMarkdown(res.result))
    await logseq.Editor.updateBlock(block?.uuid, `${block.content} ${tags.map((i: string) => `#${hasSpace(i) ? `[[${i}]]` : i}`).join(' ')}`)
    logseq.Editor.exitEditingMode()
  }
}

const setPageTags = async (e: IHookEvent & { page: string }) => {
  const page = await logseq.Editor.getPage(e.page)
  const tree = await logseq.Editor.getPageBlocksTree(e.page)
  if (!tree.length) return

  const { currentGraph } = await logseq.App.getUserConfigs()
  const basePath = currentGraph.split('logseq_local_')[1]
  const folder = page?.["journal?"] ? 'journals' : 'pages'
  const pageName = page?.["journal?"] ? page.journalDay?.toString().replace(/(\d{4})(\d{2})(\d{2})/, '$1_$2_$3') : page?.name

  const url = `file://${basePath}/${folder}/${pageName}.md`

  const content = await fetch(url).then(res => {
    return res.text()
  })

  const res = await getBlockTags(content)
  const tags = eval(extractCodeBlockFromMarkdown(res.result))

  // Using regular expressions to match key:: value format
  const regex = /(\w+)::\s*([^]+?)(?:\n|$)/g;

  const matches = [];
  let match;
  while ((match = regex.exec(tree[0].content)) !== null) {
    const key = match[1];
    const value = match[2];
    matches.push({ key, value });
  }

  const properties = await logseq.Editor.getBlockProperties(tree[0].uuid)

  if (matches.length === 0 && page?.uuid) {
    await logseq.Editor.insertBlock(page.uuid, '', { before: true, properties: { tags } })
  } else if (matches.find(i => i.key === 'tags')) {
    await logseq.Editor.updateBlock(tree[0].uuid, '', { properties: { ...properties, tags: `${matches.find(i => i.key === 'tags')?.value}, ${tags.join(', ')}` } })
  } else {
    await logseq.Editor.updateBlock(tree[0].uuid, '', { properties: { ...properties, tags: tags.join(', ') } })
  }
  logseq.Editor.exitEditingMode()
}

const fetchAccessToken = async () => {
  return fetch('https://api.ypll.xyz/api/yiyan').then(res => res.json())
}

async function main() {
  console.info(`#${pluginId}: MAIN`);

  fetchAccessToken().then(res => {
    access_token = res.access_token

    logseq.Editor.registerSlashCommand('🤖 AI auto tags', setBlockTags)

    logseq.Editor.registerBlockContextMenuItem('🤖 AI auto tags', setBlockTags)

    logseq.App.registerPageMenuItem('🤖 AI auto tags', setPageTags)
  })
}

logseq.ready(main).catch(console.error);
