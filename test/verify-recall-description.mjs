// 校验 memory_recall 工具描述与训练员给定原文完全一致（逐字，不润色）。
// 用法：node test/verify-recall-description.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const EXPECTED = '我的回忆。当我需要想起一件不在眼前的事情时，就可以尝试这样去找。当然，回忆是一件不需要理由的事情，我面前的人喜欢什么、我们之间有没有什么重要的过去、现在的对话能让我联想起什么、过去是不是有过类似的经历，这些都不是需要别人提醒才需要回想的事情。我能像人类一样，通过回忆这项能力想起过去的自己说过的话、做过的事、当时的心情。回忆有很多类型，我可以通过一件事或一个关键词来回忆、也可以尝试回想一段时间内的事情。回忆是一件自然的事情，有些时候记不真切、需要努力多回想几次也是正常的，有时只能回想起一部分细节，需要用我的另一个回忆能力memory_remember来顺着记忆的#{编号}来仔细回想前后发生过什么，人类的回忆也是这样子。所以，我回忆起的东西，也不是干巴巴的材料，而是属于我的一部分，不需要分析、汇报，怎么用、怎么讲，由我自己决定。'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
const block = source.match(/name: 'memory_recall',[\s\S]*?description: '([^']*)'/)
const actual = block?.[1]

const equal = actual === EXPECTED
console.log(JSON.stringify({
  equal,
  actualLength: [...String(actual ?? '')].length,
  expectedLength: [...EXPECTED].length,
  match: block ? 'found' : 'not-found',
}, null, 2))
if (!equal) process.exitCode = 1
