import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppUpdateService } from '../../../core/services/app-update.service';
import { UpdateBannerComponent } from './update-banner.component';

describe('UpdateBannerComponent', () => {
  const updateReady = signal(false);
  const apply = jasmine.createSpy('apply');

  beforeEach(() => {
    updateReady.set(false);
    apply.calls.reset();
    TestBed.configureTestingModule({
      imports: [UpdateBannerComponent],
      providers: [{ provide: AppUpdateService, useValue: { updateReady, apply } }]
    });
  });

  it('no muestra nada si no hay versión nueva', () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ub')).toBeNull();
  });

  it('con una versión nueva muestra el aviso y "Actualizar" la aplica', () => {
    updateReady.set(true);
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Hay una versión nueva');
    fixture.nativeElement.querySelector('.ub-btn').click();
    expect(apply).toHaveBeenCalled();
  });
});
