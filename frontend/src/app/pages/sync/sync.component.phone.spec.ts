import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { SyncComponent } from './sync.component';
import { SyncPhoneComponent } from './phone/sync-phone.component';
import { configConDb, createSyncServiceSpy, flushQuery, mockPhone, syncTestProviders } from './sync.testing';

describe('SyncComponent en el celular', () => {
  it('sin pestañas: muestra zc-sync-phone y Estado va en una hoja', async () => {
    mockPhone(true);
    const spy = createSyncServiceSpy();
    spy.getConfig.and.returnValue(of(configConDb));
    TestBed.configureTestingModule({ imports: [SyncComponent], providers: syncTestProviders(spy) });
    const fixture = TestBed.createComponent(SyncComponent);
    fixture.detectChanges();
    await flushQuery();
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.directive(SyncPhoneComponent))).toBeTruthy();
    expect(fixture.nativeElement.querySelector('zc-tabs')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Sincronización de stock');

    fixture.nativeElement.querySelector('.ph-estado').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Sincronización de stock');
    fixture.destroy();
  });
});
