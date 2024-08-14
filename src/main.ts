import "@logseq/libs";
import { BlockEntity, BlockUUID, IHookEvent } from "@logseq/libs/dist/LSPlugin.user";

import { deepFirstTraversal } from './utils'
import { logseq as PL } from "../package.json";

const BASE_URL = 'https://api.ypll.xyz'
const pluginId = PL.id;
const loadingKey = 'loading'

const hasSpace = (str: string) => /\s/.test(str)

const getBlockTags = (content: string): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    logseq.UI.showMsg('加载中...', 'warning', { key: loadingKey, timeout: 100000000 })

    fetch(`${BASE_URL}/api/yiyan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'auto-tags',
        content: `〔${content}〕`
      })
    }).then(res => {
      return res.json()
    }).then(res => {
      logseq.UI.closeMsg(loadingKey)
      if (res.error_code && res.error_msg) {
        reject(res.error_msg)
        logseq.UI.showMsg(`${JSON.stringify(res.error_msg)}`, 'error')
      } else {
        resolve(eval(res))
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
    const tags = await getBlockTags(contents.join('\n'))
    if (!Array.isArray(tags)) return
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

  const tags = await getBlockTags(content)
  if (!Array.isArray(tags)) return

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

async function main() {
  console.info(`#${pluginId}: MAIN`)

  logseq.Editor.registerSlashCommand('🤖 AI auto tags', setBlockTags)
  logseq.Editor.registerBlockContextMenuItem('🤖 AI auto tags', setBlockTags)
  logseq.App.registerPageMenuItem('🤖 AI auto tags', setPageTags)
}

logseq.ready(main).catch(console.error)
