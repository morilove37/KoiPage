import type {Account} from './types';
import {FriendsAvatar} from './FriendsAvatar';

export function FriendAvatar({user,large=false}:{user:Pick<Account,'avatar'>;large?:boolean}){
  return <FriendsAvatar avatar={user.avatar} className={large?'size-20':'size-11'}/>;
}
