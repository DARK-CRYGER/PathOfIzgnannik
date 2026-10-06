/* =========================================================
   Сервер аукциона «Пепел Изгнания»
   Node.js 18+, без зависимостей. Хранит лоты в JSON-файле.

   Запуск:
     BOT_TOKEN=123:ABC PORT=8080 node auction-server.js
   Переменные:
     BOT_TOKEN  — токен бота из @BotFather (нужен для проверки подписи Telegram)
     PORT       — порт (по умолчанию 8080)
     DATA_FILE  — путь к файлу данных (по умолчанию ./auction-data.json)
     ORIGIN     — разрешённый источник для CORS (по умолчанию *)

   Игрок определяется по Telegram user.id из подписанных initData,
   поэтому удаление персонажа не затрагивает его лоты и выручку.
   ========================================================= */
const http=require('http'),crypto=require('crypto'),fs=require('fs');
const BOT_TOKEN=process.env.BOT_TOKEN||'',PORT=+process.env.PORT||8080,DATA_FILE=process.env.DATA_FILE||'./auction-data.json',ORIGIN=process.env.ORIGIN||'*';
const TAX=.05,MAX_LOTS_PER_USER=30,MAX_ITEM_BYTES=8000,MAX_PRICE=1e9,AUTH_MAX_AGE=7*24*3600;
if(!BOT_TOKEN)console.warn('ВНИМАНИЕ: BOT_TOKEN не задан — подпись Telegram не проверяется (только для отладки)');

let db={seq:0,lots:[],sold:[],purses:{}};
try{db=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}
let saveT=null;
function persist(){clearTimeout(saveT);saveT=setTimeout(()=>{const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DATA_FILE);},200);}

/* проверка initData по алгоритму Telegram */
function verify(initData){
  if(!initData)return null;
  const p=new URLSearchParams(initData),hash=p.get('hash');p.delete('hash');
  const check=[...p.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  if(BOT_TOKEN){
    const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const h=crypto.createHmac('sha256',secret).update(check).digest('hex');
    if(!hash||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(hash)))return null;
    const age=Date.now()/1000-(+p.get('auth_date')||0);if(age>AUTH_MAX_AGE)return null;
  }
  try{const u=JSON.parse(p.get('user')||'{}');return u.id?{id:String(u.id),name:u.first_name||'Игрок'}:null;}catch(e){return null;}
}
const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'Content-Type, X-Tg-Init-Data','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});res.end(JSON.stringify(obj));};
const body=req=>new Promise(r=>{let s='';req.on('data',c=>{s+=c;if(s.length>20000)req.destroy();});req.on('end',()=>{try{r(JSON.parse(s||'{}'));}catch(e){r({});}});});
const pub=(l,me)=>({id:l.id,item:l.item,price:l.price,ts:l.ts,seller:{name:l.sellerName},mine:l.uid===me});
function cleanItem(it){
  if(!it||typeof it!=='object'||typeof it.name!=='string'||!it.slot)return null;
  const s=JSON.stringify(it);if(s.length>MAX_ITEM_BYTES)return null;
  const c=JSON.parse(s);delete c.fav;delete c.isNew;return c;
}

http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS')return send(res,204,{});
  const url=new URL(req.url,'http://x'),path=url.pathname.replace(/\/+$/,'');
  if(path===''||path==='/health')return send(res,200,{ok:true,lots:db.lots.length});
  const user=verify(req.headers['x-tg-init-data']);
  if(!user)return send(res,401,{error:'Не удалось подтвердить аккаунт Telegram'});
  try{
    if(req.method==='GET'&&path==='/lots')
      return send(res,200,{lots:db.lots.slice(-500).map(l=>pub(l,user.id))});
    if(req.method==='GET'&&path==='/me')
      return send(res,200,{lots:db.lots.filter(l=>l.uid===user.id).map(l=>pub(l,user.id)),
        sold:db.sold.filter(l=>l.uid===user.id).slice(-15).reverse().map(l=>({item:l.item,price:l.price,buyer:l.buyerName})),purse:db.purses[user.id]||0});
    if(req.method==='POST'&&path==='/lots'){
      const b=await body(req),it=cleanItem(b.item),price=Math.floor(+b.price);
      if(!it)return send(res,400,{error:'Некорректный предмет'});
      if(!(price>=1&&price<=MAX_PRICE))return send(res,400,{error:'Некорректная цена'});
      if(db.lots.filter(l=>l.uid===user.id).length>=MAX_LOTS_PER_USER)return send(res,400,{error:`Не больше ${MAX_LOTS_PER_USER} лотов`});
      const lot={id:'L'+(++db.seq),uid:user.id,sellerName:String(b.seller||user.name).slice(0,24),item:it,price,ts:Date.now()};
      db.lots.push(lot);persist();return send(res,200,{id:lot.id});
    }
    const m=path.match(/^\/lots\/([\w-]+)\/(buy|cancel)$/);
    if(req.method==='POST'&&m){
      const i=db.lots.findIndex(l=>l.id===m[1]);if(i<0)return send(res,404,{error:'Лот уже продан или снят'});
      const lot=db.lots[i];
      if(m[2]==='cancel'){if(lot.uid!==user.id)return send(res,403,{error:'Это не ваш лот'});db.lots.splice(i,1);persist();return send(res,200,{item:lot.item});}
      if(lot.uid===user.id)return send(res,400,{error:'Нельзя купить собственный лот'});
      const b=await body(req);db.lots.splice(i,1);
      db.purses[lot.uid]=(db.purses[lot.uid]||0)+Math.round(lot.price*(1-TAX));
      db.sold.push({uid:lot.uid,item:{name:lot.item.name,rar:lot.item.rar},price:lot.price,buyerName:String(b.buyer||user.name).slice(0,24),ts:Date.now()});
      if(db.sold.length>5000)db.sold=db.sold.slice(-4000);
      persist();return send(res,200,{item:lot.item});
    }
    if(req.method==='POST'&&path==='/claim'){const g=db.purses[user.id]||0;db.purses[user.id]=0;persist();return send(res,200,{gold:g});}
    return send(res,404,{error:'Не найдено'});
  }catch(e){console.error(e);return send(res,500,{error:'Ошибка сервера'});}
}).listen(PORT,()=>console.log('Аукцион слушает порт',PORT));
