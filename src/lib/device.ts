import { v4 as uuidv4 } from 'uuid';

export function getDeviceId(): string {
  let deviceId = localStorage.getItem('core_elite_device_id');
  if (!deviceId) {
    deviceId = `device-${uuidv4().slice(0, 8)}`;
    localStorage.setItem('core_elite_device_id', deviceId);
  }
  return deviceId;
}
