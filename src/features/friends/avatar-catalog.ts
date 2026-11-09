export interface CharacterAvatar {id:number;name:string;work:string;src:string}

/** Stable server IDs; reordering the picker must not renumber saved accounts. */
export const CHARACTER_AVATARS:readonly CharacterAvatar[]=[
  {id:0,name:'古河渚',work:'CLANNAD',src:'/friends/avatars/nagisa-furukawa.png'},
  {id:1,name:'坂上智代',work:'CLANNAD',src:'/friends/avatars/tomoyo-sakagami.png'},
  {id:2,name:'神尾观铃',work:'AIR',src:'/friends/avatars/misuzu-kamio.png'},
  {id:3,name:'月宫亚由',work:'Kanon',src:'/friends/avatars/ayu-tsukimiya.png'},
  {id:4,name:'能美库特莉亚芙卡',work:'Little Busters!',src:'/friends/avatars/kudryavka-noumi.png'},
  {id:5,name:'鸣濑白羽',work:'Summer Pockets',src:'/friends/avatars/shiroha-naruse.png'},
  {id:6,name:'久岛鸥',work:'Summer Pockets',src:'/friends/avatars/kamome-kushima.png'},
  {id:7,name:'丛雨',work:'千恋万花',src:'/friends/avatars/murasame.png'},
  {id:8,name:'朝武芳乃',work:'千恋万花',src:'/friends/avatars/yoshino-tomotake.png'},
  {id:9,name:'绫地宁宁',work:'魔女的夜宴',src:'/friends/avatars/nene-ayachi.png'},
  {id:10,name:'三司绫濑',work:'RIDDLE JOKER',src:'/friends/avatars/ayase-mitsukasa.png'},
  {id:11,name:'冬马和纱',work:'WHITE ALBUM2',src:'/friends/avatars/kazusa-touma.png'},
  {id:12,name:'小木曾雪菜',work:'WHITE ALBUM2',src:'/friends/avatars/setsuna-ogiso.png'},
  {id:13,name:'Saber',work:'Fate/stay night',src:'/friends/avatars/saber.png'},
  {id:14,name:'远坂凛',work:'Fate/stay night',src:'/friends/avatars/rin-tohsaka.png'},
  {id:15,name:'牧濑红莉栖',work:'STEINS;GATE',src:'/friends/avatars/kurisu-makise.png'},
  {id:16,name:'水无月萤',work:'天津罪',src:'/friends/avatars/hotaru-minazuki.png'},
  {id:17,name:'和泉妃爱',work:'灵感满溢的甜蜜创想',src:'/friends/avatars/hiyori-izumi.png'},
];

export const avatarPreset=(id:number):CharacterAvatar=>CHARACTER_AVATARS.find(item=>item.id===id)??CHARACTER_AVATARS[0];
export const AVATAR_CHOICES=[...CHARACTER_AVATARS.filter(item=>item.id>=16),...CHARACTER_AVATARS.filter(item=>item.id<16)];
