import { Context, Dict, Schema, Time, deepEqual, pick, sleep } from 'koishi'
import {} from '@koishijs/plugin-market'
import type { SearchObject, SearchResult } from '@koishijs/registry'

export const name = 'market-info-pro'

interface Receiver {
  platform: string
  selfId: string
  channelId: string
  guildId?: string
  plugins?: string[]  // 订阅的特定插件列表
}

const Receiver: Schema<Receiver> = Schema.object({
  platform: Schema.string().required().description('平台名称。'),
  selfId: Schema.string().required().description('机器人 ID。'),
  channelId: Schema.string().required().description('频道 ID。'),
  guildId: Schema.string().description('群组 ID。'),
  plugins: Schema.array(Schema.string()).default([]).description('订阅的特定插件列表，留空表示订阅所有插件。'),
})

export interface Config {
  rules: Receiver[]
  endpoint: string
  interval: number
  showHidden: boolean
  showDeletion: boolean
  showPublisher: boolean
  showDescription: boolean
}

export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(Receiver).role('table').description('推送规则列表。'),
  endpoint: Schema.string().default('https://registry.koishi.chat/index.json').description('插件市场地址。'),
  interval: Schema.number().default(Time.minute * 30).description('轮询间隔 (毫秒)。'),
  showHidden: Schema.boolean().default(false).description('是否显示隐藏的插件。'),
  showDeletion: Schema.boolean().default(false).description('是否显示删除的插件。'),
  showPublisher: Schema.boolean().default(false).description('是否显示插件发布者。'),
  showDescription: Schema.boolean().default(false).description('是否显示插件描述。'),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('market')

  const makeDict = (result: SearchResult) => {
    const dict: Dict<SearchObject> = {}
    for (const object of result.objects) {
      if (object.manifest.hidden && !config.showHidden) continue
      dict[object.shortname] = object
    }
    return dict
  }

  const getMarket = async () => {
    const data = await ctx.http.get<SearchResult>(config.endpoint)
    return makeDict(data)
  }

  ctx.on('ready', async () => {
    let previous = await getMarket()

    ctx.command('market [name]')
      .option('receive', '-r', { authority: 3, value: true })
      .option('receive', '-R', { authority: 3, value: false })
      .option('subscribe', '-s <plugin:string>', { 
        authority: 3, 
        type: 'string',
        desc: '订阅特定插件的更新通知' 
      })
      .option('unsubscribe', '-u <plugin:string>', { 
        authority: 3, 
        type: 'string',
        desc: '取消订阅特定插件' 
      })
      .option('list', '-l', { 
        authority: 3, 
        value: true,
        desc: '查看当前频道的订阅列表'
      })
      .action(async ({ session, options }, name) => {
        // 管理订阅列表的功能
        if (options.subscribe || options.unsubscribe || options.list) {
          const receiver = config.rules.find(receiver => {
            return deepEqual(
              pick(receiver, ['platform', 'selfId', 'channelId', 'guildId']),
              pick(session, ['platform', 'selfId', 'channelId', 'guildId']),
            )
          })
          
          if (!receiver) return '当前频道尚未订阅插件更新通知，请先使用 `market -r` 启用订阅'
          
          // 查看订阅列表
          if (options.list) {
            if (!receiver.plugins?.length) return '当前频道没有订阅特定插件，将接收所有插件的更新通知'
            return `当前频道订阅的插件列表：\n${receiver.plugins.join('\n')}`
          }
          
          // 订阅插件
          if (options.subscribe) {
            const plugin = options.subscribe.trim()
            if (plugin === '*') {
              // 订阅全部插件
              receiver.plugins = []
              ctx.scope.update(config, false)
              return '已订阅所有插件的更新通知'
            }
            
            if (!receiver.plugins.includes(plugin)) {
              receiver.plugins = [...(receiver.plugins || []), plugin]
              ctx.scope.update(config, false)
            }
            return `已成功订阅插件 "${plugin}" 的更新通知`
          }
          
          // 取消订阅
          if (options.unsubscribe) {
            const plugin = options.unsubscribe.trim()
            if (plugin === '*') {
              // 取消所有特定订阅（回到订阅全部状态）
              receiver.plugins = []
              ctx.scope.update(config, false)
              return '已取消所有特定订阅，将接收所有插件的更新通知'
            }
            
            const index = receiver.plugins.indexOf(plugin)
            if (index >= 0) {
              receiver.plugins.splice(index, 1)
              ctx.scope.update(config, false)
              return `已取消订阅插件 "${plugin}"`
            }
            return `当前频道未订阅插件 "${plugin}"`
          }
        }
        
        // 管理接收规则的开关
        if (typeof options.receive === 'boolean') {
          const index = config.rules.findIndex(receiver => {
            return deepEqual(
              pick(receiver, ['platform', 'selfId', 'channelId', 'guildId']),
              pick(session, ['platform', 'selfId', 'channelId', 'guildId']),
            )
          })
          if (options.receive) {
            if (index >= 0) return '订阅信息未修改'
            config.rules.push({
              ...pick(session, ['platform', 'selfId', 'channelId', 'guildId']),
              plugins: []  // 默认订阅全部插件
            })
          } else {
            if (index < 0) return '订阅信息未修改'
            config.rules.splice(index, 1)
          }
          ctx.scope.update(config, false)
          return '订阅设置已更新'
        }
  
        // 查询插件市场信息
        if (!name) {
          const objects = Object.values(previous).filter(data => !data.manifest.hidden)
          return `当前共有 ${objects.length} 个可见插件`
        }

        const data = previous[name]
        if (!data) return `未找到插件 "${name}"`
        
        // 构建插件详情
        const { manifest, package: pkg } = data
        const description = typeof manifest.description === 'string' 
          ? manifest.description 
          : manifest.description?.zh || manifest.description?.en || ''
        
        return `${manifest.name} (${pkg.version})\n${description}`
      })

    ctx.setInterval(async () => {
      const current = await getMarket()
      
      // 检测所有变更
      const changes = Object.keys({ ...previous, ...current }).map((name) => {
        const oldVersion = previous[name]?.package.version
        const newVersion = current[name]?.package.version
        
        // 没有变化
        if (oldVersion === newVersion) return null
        
        let changeType = ''
        let message = ''
        
        // 新增插件
        if (!oldVersion && newVersion) {
          changeType = 'created'
          message = `新增：${name}`
          if (config.showPublisher && current[name]?.package.publisher?.username) {
            message += ` (@${current[name].package.publisher.username})`
          }
          if (config.showDescription) {
            const { description } = current[name].manifest
            if (description) {
              const descText = typeof description === 'string' ? description : 
                               (description.zh || description.en || '')
              if (descText) message += `\n  ${descText}`
            }
          }
        } 
        // 插件更新
        else if (oldVersion && newVersion) {
          changeType = 'updated'
          message = `更新：${name} (${oldVersion} → ${newVersion})`
        } 
        // 插件删除
        else if (oldVersion && !newVersion) {
          if (!config.showDeletion) return null
          changeType = 'deleted'
          message = `移除：${name}`
        }
        
        return {
          name,
          type: changeType,
          message
        }
      }).filter(Boolean)
      
      previous = current
      if (!changes.length) return
      
      // 为每个接收器过滤其订阅的变更
      const messagesToSend: { receiver: Receiver, message: string }[] = []
      
      for (const receiver of config.rules) {
        // 筛选该接收器关心的变更
        const relevantChanges = changes.filter(change => {
          // 如果没有指定特定插件，接收所有变更
          if (!receiver.plugins?.length) return true
          
          // 只接收特定插件的变更
          return receiver.plugins.includes(change.name)
        })
        
        if (!relevantChanges.length) continue
        
        // 构建消息
        const changeMessages = relevantChanges.map(c => c.message)
        const message = ['[插件市场更新]', ...changeMessages].join('\n')
        
        messagesToSend.push({
          receiver,
          message
        })
      }
      
      if (!messagesToSend.length) return
      
      // 发送通知
      logger.info(`检测到市场更新，将发送 ${messagesToSend.length} 条通知`)
      
      const delay = ctx.root.config.delay?.broadcast || 0
      for (let index = 0; index < messagesToSend.length; index++) {
        if (index && delay) await sleep(delay)
        
        const { receiver, message } = messagesToSend[index]
        const { platform, selfId, channelId, guildId } = receiver
        
        try {
          const bot = ctx.bots.find(bot => 
            bot.platform === platform && bot.selfId === selfId
          )
          
          if (bot) {
            await bot.sendMessage(channelId, message, guildId)
            logger.debug(`已向 ${platform}/${channelId} 发送市场更新通知`)
          } else {
            logger.warn(`找不到匹配的机器人: ${platform}/${selfId}`)
          }
        } catch (err) {
          logger.warn(`通知发送失败 (${platform}/${channelId}): ${err.message}`)
        }
      }
    }, config.interval)
  })
}
