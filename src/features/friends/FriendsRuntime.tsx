import {useEffect} from 'react';
import {friendsStatus} from './api';
/** Native background runtime owns publication, even while the WebView is hidden. */
export function FriendsRuntime(){useEffect(()=>{void friendsStatus().catch(()=>{});},[]);return null;}
