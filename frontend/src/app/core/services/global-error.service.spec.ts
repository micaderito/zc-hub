import { TestBed } from '@angular/core/testing';
import { GlobalErrorService } from './global-error.service';

describe('GlobalErrorService', () => {
  let service: GlobalErrorService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GlobalErrorService);
  });

  it('starts with no message', () => {
    expect(service.message()).toBeNull();
  });

  it('show() sets the message', () => {
    service.show('algo falló');
    expect(service.message()).toBe('algo falló');
  });

  it('show() falls back to a default message when given an empty string', () => {
    service.show('');
    expect(service.message()).toBe('Error desconocido');
  });

  it('clear() resets the message to null', () => {
    service.show('algo falló');
    service.clear();
    expect(service.message()).toBeNull();
  });
});
