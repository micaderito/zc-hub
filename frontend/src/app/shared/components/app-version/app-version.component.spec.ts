import { TestBed } from '@angular/core/testing';
import { AppVersionComponent } from './app-version.component';

describe('AppVersionComponent', () => {
  function create(health: object | null) {
    spyOn(window, 'fetch').and.returnValue(Promise.resolve(new Response(JSON.stringify(health ?? {}), { status: health ? 200 : 500 })));
    const fixture = TestBed.createComponent(AppVersionComponent);
    return fixture;
  }

  it('en local muestra "local" sin aviso', async () => {
    const fixture = create({ ok: true, version: null, sha: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('local');
    expect(fixture.componentInstance.mismatch()).toBeFalse();
  });

  it('avisa cuando el front y el back no son el mismo commit', async () => {
    const fixture = create({ ok: true, version: 'v72', sha: 'bbbbbbb' });
    fixture.componentInstance.front.set({ version: 'v73', sha: 'aaaaaaa', date: '' });
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    expect(fixture.componentInstance.mismatch()).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Front v73 · Back v72');
  });

  it('con la misma versión muestra solo "Versión vN"', async () => {
    const fixture = create({ ok: true, version: 'v73', sha: 'aaaaaaa' });
    fixture.componentInstance.front.set({ version: 'v73', sha: 'aaaaaaa', date: '' });
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    expect(fixture.componentInstance.mismatch()).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Versión v73');
  });
});
