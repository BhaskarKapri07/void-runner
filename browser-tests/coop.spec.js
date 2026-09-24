import { test, expect } from '@playwright/test';
for(const hostmode of ['peer','server'])test(`${hostmode}: four browsers, immediate movement, synchronized positions`,async({browser})=>{
 const pages=[],errors=[];
 for(let i=0;i<4;i++){const page=await browser.newPage();pages.push(page);await page.addInitScript(()=>{window.VOIDRUNNER_ICE_SERVERS=[]});page.on('pageerror',e=>errors.push(e.message));if(hostmode==='peer')await page.addInitScript(()=>{const original=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(data){let m;try{m=JSON.parse(data)}catch{}if(m?.type==='frames'||m?.type==='state'){const channel=this;setTimeout(()=>{if(channel.readyState==='open')original.call(channel,data)},100)}else original.call(this,data)}});await page.goto('http://127.0.0.1:3000/');await page.locator('#online').click();await page.locator('#hostmode').selectOption(hostmode);await page.locator('#pilotname').fill('Pilot '+i)}
 try{
 await pages[0].locator('#createRoom').click();await expect(pages[0].locator('#netbar')).toBeVisible();const code=await pages[0].locator('#netbar b').innerText();
 for(let i=1;i<4;i++){await pages[i].locator('#roomcode').fill(code);await pages[i].locator('#joinRoom').click();await expect(pages[i].locator('.pilotcard')).toHaveCount(i+1,{timeout:12000})}
 await expect(pages[0].locator('.pilotcard')).toHaveCount(4);await pages[0].locator('#startSquad').click();
 for(const p of pages)await expect.poll(()=>p.evaluate(()=>window.netDiagnostics().phase)).toBe('play');
 const guest=pages[1];const before=await guest.evaluate(()=>window.netDiagnostics());await guest.keyboard.down('ArrowRight');await guest.waitForTimeout(120);const during=await guest.evaluate(()=>window.netDiagnostics());await guest.keyboard.up('ArrowRight');expect(during.predicted.x).toBeGreaterThan(before.predicted.x+10);if(hostmode==='peer'){const authoritative=during.players.find(p=>p.id===during.me);expect(during.predicted.x).toBeGreaterThan(authoritative.x+5);}
 await guest.waitForTimeout(400);const settled=await guest.evaluate(()=>window.netDiagnostics());const host=await pages[0].evaluate(()=>window.netDiagnostics());const guestOnHost=host.players.find(p=>p.id===settled.me);expect(Math.abs(guestOnHost.x-settled.predicted.x)).toBeLessThan(12);
 // With 100 ms injected each way in peer mode, bullets within 150 ms can only be the local prediction.
 await guest.keyboard.down('Space');await expect.poll(()=>guest.evaluate(()=>window.netDiagnostics().bullets),{timeout:150}).toBeGreaterThan(0);await guest.waitForTimeout(400);await guest.keyboard.up('Space');for(const p of pages){const d=await p.evaluate(()=>window.netDiagnostics());expect(d.synced).toBe(true);expect(d.bullets).toBeGreaterThan(0)}expect(errors).toEqual([]);
 }catch(error){for(const p of pages)console.log('CLIENT FAILURE',await p.evaluate(()=>({text:document.body.innerText,diagnostics:window.netDiagnostics?.()})));throw error;}finally{for(const p of pages)await p.close()}
});
test('peer: host keeps simulating for guests when its animation frames stop',async({browser})=>{
 const pages=[],errors=[];
 try{
 for(const url of ['http://127.0.0.1:3000/','http://127.0.0.1:3000/']){const page=await browser.newPage();pages.push(page);await page.addInitScript(()=>{window.VOIDRUNNER_ICE_SERVERS=[]});page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.locator('#online').click();await page.locator('#hostmode').selectOption('peer')}
 const [host,guest]=pages;await host.locator('#createRoom').click();await expect(host.locator('#netbar')).toBeVisible();const code=await host.locator('#netbar b').innerText();
 await guest.locator('#roomcode').fill(code);await guest.locator('#joinRoom').click();await expect(host.locator('.pilotcard')).toHaveCount(2);await host.locator('#startSquad').click();
 for(const p of pages)await expect.poll(()=>p.evaluate(()=>window.netDiagnostics().phase)).toBe('play');
 // A hidden tab gets no animation frames; drop the host's frame hook to the same effect.
 await host.evaluate(()=>{window.netUpdate=()=>{}});
 const before=await guest.evaluate(()=>window.netDiagnostics());await guest.keyboard.down('ArrowRight');await guest.waitForTimeout(300);await guest.keyboard.up('ArrowRight');await guest.waitForTimeout(300);
 const after=await guest.evaluate(()=>window.netDiagnostics()),start=before.players.find(p=>p.id===before.me),end=after.players.find(p=>p.id===after.me);
 expect(end.x).toBeGreaterThan(start.x+40);expect(Math.abs(end.x-after.predicted.x)).toBeLessThan(12);expect(errors).toEqual([]);
 }catch(error){for(const p of pages)console.log('CLIENT FAILURE',JSON.stringify(await p.evaluate(()=>window.netDiagnostics?.())));throw error;}finally{for(const p of pages)await p.close()}
});
test('server: leaving mid-run returns to a working lobby',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3000/');await page.locator('#online').click();await page.locator('#hostmode').selectOption('server');
 await page.locator('#createRoom').click();await expect(page.locator('#startSquad')).toBeVisible();await page.locator('#startSquad').click();
 await expect.poll(()=>page.evaluate(()=>window.netDiagnostics().phase)).toBe('play');
 // Input frames are still queued when the pilot leaves; the next send used to throw and stop the game loop.
 await page.keyboard.down('ArrowRight');await page.waitForTimeout(100);await page.locator('#leaveRoom').click();await page.waitForTimeout(300);await page.keyboard.up('ArrowRight');
 expect(errors).toEqual([]);
 await page.locator('#createRoom').click();await expect(page.locator('#startSquad')).toBeVisible();expect(errors).toEqual([]);
});
