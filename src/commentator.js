'use strict';
// src/commentator.js — 场外中立解说引擎（主播用）
// 铁律：只用公开信息（号码/票数/死亡/处决揭示/公屏气泡），绝不泄露身份

const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const CFG = require('./config').load(); // 统一配置中心（config.json 可改剧本）

// 内置兜底台词（config.script 为空时回退；用户改 config 即可覆盖）
const FALLBACK = {
  phases: {
    Hide: [
      `天黑了，各位选手请选边站队。今晚又会是哪几个房间热闹非凡呢？`,
      `夜幕降临，灯光熄灭。建议大家抱团取暖，当然——也可能抱错了团`,
      `到了每晚一度的“分房之夜”，选择比努力更重要，祝各位好运`,
    ],
    Night: [
      `深夜档开始，今夜无人入眠。让我们数一唱，明早还能剩下几位`,
      `狼人营业时间到。温馨提示：大厅不一定安全，房间里也不一定危险`,
      `长夜漫漫，各位好自为之。我已经搬好小板凳准备吃席了`,
    ],
    SelectPlayer: [
      `天光大亮，又到了白天“民主”的时刻。今天谁来当这个倒霉蛋……哦不，幸运儿`,
      `白天议程第一项：选人上台。记住，每一票都是一把刀，请谨慎挥刀`,
      `好了好了，开始你们的表演。今天准备把谁送上天台？`,
    ],
    VotePlayer: [
      `选手已经上台，现在是决定生死的时刻。444还是666，一念天堂一念地狱`,
      `投票通道开启！友情提示：跟票有风险，冲票需谨慎`,
      `最刺激的环节来了——是留下他，还是送走他？`,
    ],
    VoteResult: [
      `全员投票完毕，结果即将揭晓，掌声有请——`,
      `计票结束，这一刻，有人笑就有人哭`,
      `命运的时刻到了，让我们看看这位选手的命运如何`,
    ],
    End: [
      `对局结束！无论结果如何，这都是一局精彩的博弈，感谢各位`,
      `Game over！胜负已分，让我们把掌声献给所有选手`,
      `结束了结束了，今晚又是几家欢喜几家愁`,
    ],
  },
  nightResult: {
    zero: [
      `平安夜！昨晚一个人都没走，狼人今晚集体休假了吗`,
      `不可思议，昨夜零伤亡，这是道德的沦丧还是狼性的泯灭`,
    ],
    heavy: [
      `腥风血雨的一夜！{n}位选手告别赛场，场上气氛直接凝固`,
      `昨晚是个不眠之夜，{n}人出局，这效率，狼人KPI直接拉满`,
      `可怕，{n}条鲜活的生命……我现在满脑子都是今晚吃什么的哲学问题`,
    ],
    normal: [
      `昨夜{n}位选手离场，有人还没来得及告别`,
      `安静的一夜，{n}人离开。有时候，安静才最可怕`,
      `{n}人出局。狼人这刀法，颇有刺客信条的风范`,
    ],
  },
  execution: {
    wolf: [
      `{no}号倒下了——他的身份是狼人！好人阵营这波血赚，掌声在哪里！`,
      `事实证明{no}号就是一匹狼！这一刀，干净利落！`,
      `{no}号：狼人。恭喜各位，今天成功揪出一头，继续加油！`,
    ],
    good: [
      `{no}号倒下了——他的身份是……好人。天呐，这是一起冤案！`,
      `残酷的现实：{no}号是清白的好人。狼人在暗处笑开了花`,
      `{no}号用生命证明了什么叫“百口莫辩”。今晚，好人阵营需要反思`,
    ],
  },
};
// 取配置数组；为空/非数组时回退内置
function arrOf(cfgArr, fb) { return (Array.isArray(cfgArr) && cfgArr.length) ? cfgArr : fb; }
// 把 {n}/{no} 占位符替换成实际数字
function fmt(arr, map) { return arr.map(s => s.replace(/\{n\}/g, map.n == null ? '' : map.n).replace(/\{no\}/g, map.no == null ? '' : map.no)); }

class Commentator {
  constructor() {
    this.lastSpeak = 0;
    this.excitement = 0;      // 近期激烈度 0-1
    this.lastDeathCount = 0;
    this.quietSince = Date.now();
    this.dayNo = 0;
  }
  ok(minGap = 9000) {
    const now = Date.now();
    if (now - this.lastSpeak < minGap) return false;
    this.lastSpeak = now;
    return true;
  }
  // 阶段切换解说（config.script.phases 可改，缺则用内置）
  onPhase(phase, night) {
    this.dayNo = night;
    const arr = arrOf(CFG.script.phases[phase], FALLBACK.phases[phase]);
    return arr && arr.length ? rnd(arr) : '';
  }
  // 夜晚结果（只报公开事实：死了几个、怎么死的）
  onNightResult(deaths, total) {
    this.lastDeathCount = deaths;
    this.excitement = Math.min(1, this.excitement + deaths * 0.12);
    if (!deaths) return rnd(fmt(arrOf(CFG.script.nightResult.zero, FALLBACK.nightResult.zero), { n: deaths }));
    if (deaths >= 4) return rnd(fmt(arrOf(CFG.script.nightResult.heavy, FALLBACK.nightResult.heavy), { n: deaths }));
    return rnd(fmt(arrOf(CFG.script.nightResult.normal, FALLBACK.nightResult.normal), { n: deaths }));
  }
  // 选人阶段播报（实时票数）
  onSelectLeader(leaderNo, votes, total) {
    if (votes >= 3) {
      this.excitement = Math.min(1, this.excitement + 0.08);
      return rnd([
        `${leaderNo}号选手目前以${votes}票领跑，人气……或者说“狼气”爆棚`,
        `目前${leaderNo}号${votes}票暂时领先，这是要起飞啊`,
        `${leaderNo}号已经被${votes}票盯上了，站在聚光灯下感觉如何？`,
      ]);
    }
    return rnd([
      `目前${leaderNo}号以${votes}票暂列第一，战况还早，变数犹存`,
      `${leaderNo}号${votes}票，领先优势不大，随时可能易主`,
    ]);
  }
  // 投票摇摆（票数变化）
  onVoteSwing(kill, life) {
    const diff = Math.abs(kill - life);
    this.excitement = Math.min(1, this.excitement + 0.1);
    if (diff <= 1) return rnd([
      `杀票${kill}对救票${life}！一票之差，全场窒息！`,
      `${kill}比${life}，这票型咬得死死的，编剧都不敢这么写`,
      `焦灼！杀${kill}救${life}，每一位观众的心都提到了嗓子眼`,
    ]);
    if (kill > life) return `杀票${kill}对救票${life}，天平正在向“送走”倾斜`;
    return `杀票${kill}对救票${life}，“留下”的声音暂时占据上风`;
  }
  // 处决结果（处决揭示身份是公开信息；config.script.execution 可改）
  onExecution(no, isWolf) {
    this.excitement = Math.min(1, this.excitement + 0.2);
    const pool = isWolf
      ? arrOf(CFG.script.execution.wolf, FALLBACK.execution.wolf)
      : arrOf(CFG.script.execution.good, FALLBACK.execution.good);
    return rnd(fmt(pool, { no }));
  }
  // 公屏技能播报（复活/亡语等公开气泡）
  onSkill(text) {
    this.excitement = Math.min(1, this.excitement + 0.15);
    return `突发！场上出现异动——${text}！这局的水越来越深了`;
  }
  // ---------- 24 角色技能「灵活触发」专用播报（差异化解说） ----------
  onRevival(no, name) {
    this.excitement = Math.min(1, this.excitement + 0.2);
    return rnd([
      `突发异变！${name}（${no}号）被比赛女巫一瓶药剂硬生生拉了回来——这都能复活？弹幕扣6！`,
      `奇迹时刻！${no}号${name}从死亡名单上被划掉，比赛女巫的瓶子比阎王簿还好使`,
      `等等，${name}（${no}号）又站起来了！这就是比赛女巫的「瓶子复活」，好人阵营血赚`,
    ]);
  }
  onVaseRevive() {
    this.excitement = Math.min(1, this.excitement + 0.2);
    return rnd([
      `注意！花瓶妹把一名倒下的好人从投票席上拉了回来——花瓶不是摆设，关键时刻能续命！`,
      `花瓶妹发动「复活」：被处决的好人满血归来，这波反转比剧本还刺激`,
      `场上出现逆转！花瓶妹一瓶下去，刚被投出去的选手又站起来了，弹幕刷起来`,
    ]);
  }
  onHallKill(no, name) {
    return rnd([
      `${name}（${no}号）躲在大厅，还是没躲过老鼠的毒手……大厅也不是安全屋啊`,
      `大厅翻车！${no}号${name}被老鼠带走了，下次还敢蹲大厅吗`,
      `老鼠今晚加餐——${name}（${no}号）在大厅被一口闷掉，惨`,
    ]);
  }
  onDeathRattle(no, name, wolfDown) {
    this.excitement = Math.min(1, this.excitement + 0.15);
    if (wolfDown) return rnd([`${name}（${no}号）倒下前死死拽住一头狼一起走——这就是妈宝的亡语，狠！`, `妈宝亡语发动！${no}号${name}临死还拉了个垫背的狼，这波不亏`]);
    return rnd([`${name}（${no}号）带着妈宝的怨念倒下了，临走还嘟囔「都怪你们」`, `妈宝男${no}号${name}亡语触发，可惜没拽到人，白给`]);
  }
  onAdultKill(no) {
    this.excitement = Math.min(1, this.excitement + 0.15);
    return rnd([`${no}号被傲白大人当众一刀带走——大人出手，从不拖泥带水！`, `傲白大人亲自刀人，${no}号这下彻底凉了，这就是大人的威压`]);
  }
  onWitchSave(no, name) {
    return rnd([`女巫一手神仙水，把${name}（${no}号）从鬼门关拽了回来，这波操作我给满分`, `女巫施救！${no}号${name}死里逃生，狼人今晚白忙活`, `神仙水续命——${name}（${no}号）被女巫从死亡边缘拉回`]);
  }
  onWitchPoison(no, name) {
    return rnd([`悄悄的，${name}（${no}号）喝了女巫的毒，悄无声息地退出了牌桌`, `女巫下毒，${no}号${name}连遗言都没来得及留就倒了`, `又一杯毒药下肚，${name}（${no}号）成了女巫的暗杀目标`]);
  }
  onSeerCheck() {
    return rnd([`预言家今晚又闭眼查验去了，谁的身份在他眼里无所遁形（虽然他不会说）`, `预言家正在暗中查验，真假美猴王即将现形`, `夜深了，预言家睁开了「天眼」——今晚谁的身份要藏不住了`]);
  }
  onSeerDead(no, name) {
    this.excitement = Math.min(1, this.excitement + 0.2);
    return rnd([`预言家${name}（${no}号）倒下了！从此再无人能看穿狼的伪装，好人阵营痛失灯塔`, `预言家${no}号${name}阵亡，真相的灯灭了，狼人可以更放肆了`]);
  }
  onNineFoxAwake() {
    return rnd([`九尾狐觉醒！场上的局势要变天了`, `九尾狐睁眼，今晚的剧本它说了算`]);
  }
  // 平淡期填充
  filler(alive, wolvesMin) {
    this.excitement = Math.max(0, this.excitement - 0.05);
    return rnd([
      `目前场上还剩${alive}位选手。温馨提示：狼至少还有${wolvesMin}头，请大家深呼吸`,
      `战况暂时平稳，正好给大家复盘一下：到目前为止，每一位倒下的选手都值得我们尊重`,
      `场上局势风平浪静，但根据我多年吃席经验，暴风雨前总是格外安静`,
      `各位观众，觉得精彩的扣1，觉得无聊的扣2，觉得我是托的扣……算了我不敢看`,
      `小声说一句：现在还在场上的，有一个算一个，都有嫌疑。别问我为什么，解说の直觉`,
      `让我们把镜头给到狼人阵营——当然，他们是不会露脸的`,
    ]);
  }
}

module.exports = { Commentator };
