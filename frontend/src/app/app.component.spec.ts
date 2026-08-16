import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { GlobalErrorService } from './core/services/global-error.service';

describe('AppComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])]
    });
  });

  it('se crea', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('muestra el banner de error global cuando GlobalErrorService tiene un mensaje', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const globalError = TestBed.inject(GlobalErrorService);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.global-error')).toBeNull();

    globalError.show('algo falló');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.global-error-text').textContent).toContain('algo falló');
  });

  it('el botón de cerrar del error global limpia el mensaje', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const globalError = TestBed.inject(GlobalErrorService);
    globalError.show('algo falló');
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.global-error-dismiss').click();
    fixture.detectChanges();

    expect(globalError.message()).toBeNull();
    expect(fixture.nativeElement.querySelector('.global-error')).toBeNull();
  });
});
