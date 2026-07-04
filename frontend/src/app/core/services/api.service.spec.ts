import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';
import { environment } from '../../../environments/environment';

describe('ApiService', () => {
  let service: ApiService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ApiService);
  });

  it('expone la baseUrl configurada en el environment', () => {
    expect(service.baseUrl).toBe(environment.apiUrl);
  });
});
