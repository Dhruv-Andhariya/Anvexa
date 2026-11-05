// Public entry of the group-discussion module (M18). Other modules import ONLY from here.
export { GroupDiscussionModule } from './group-discussion.module';
export { isGroupDiscussionRound } from './planning';
export { GdMailService, type GdStudentLink } from './gd-mail.service';
export { gdWorkerConfigFromEnv } from './gd.worker';
