import { defaultDataDir, writeSettings } from '../server/settings.mjs';

const name = process.argv.slice(2).join(' ');
try {
  writeSettings(defaultDataDir(), { companyName: name });
  console.log('회사명을 이 컴퓨터에 저장했습니다. 사무실 화면을 새로고침해주세요.');
} catch (error) {
  console.error(error.statusCode === 400 ? '사용법: npm run company -- "나의 회사 이름" (줄바꿈 없이 1~80자)'
    : '회사명을 저장하지 못했습니다. 기존 설정은 보존했습니다.');
  process.exitCode = 1;
}
